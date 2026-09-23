import { createClient } from "npm:@supabase/supabase-js@2.112.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Capability check, not a role-name check: permissions live on
    // roles.can_manage/is_admin now, and the old "Manager" role was
    // renamed Administrator. Calling is_manager() through userClient (the
    // caller's own JWT, not the service-role key) runs it as the caller,
    // so it reads the exact same auth.uid() the RLS policies would.
    const { data: canManage, error: canManageError } = await userClient.rpc("is_manager");
    if (canManageError || !canManage) {
      return new Response(JSON.stringify({ error: "Only managers can send invites" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // org_id always comes from the inviter's own profile, never the
    // request body — a client can send whatever it likes.
    const { data: orgId, error: orgIdError } = await userClient.rpc("my_org_id");
    if (orgIdError || !orgId) {
      return new Response(JSON.stringify({ error: "Could not determine your organisation" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Request body must be valid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { email, role, firstName, fullName, primaryLocationId, additionalLocationIds, redirectBase } = body;

    // Security audit finding 2 (2026-09-23): typeof narrows this from
    // whatever shape a raw client sends before it ever reaches an actual
    // email API. .includes("@") alone let "not-an-email" through.
    const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (typeof email !== "string" || !EMAIL_PATTERN.test(email)) {
      return new Response(JSON.stringify({ error: "A valid email is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof firstName !== "undefined" && (typeof firstName !== "string" || firstName.length > 100)) {
      return new Response(JSON.stringify({ error: "First name must be 100 characters or fewer" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (typeof fullName !== "undefined" && (typeof fullName !== "string" || fullName.length > 100)) {
      return new Response(JSON.stringify({ error: "Full name must be 100 characters or fewer" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof role !== "string" || !role.trim()) {
      return new Response(JSON.stringify({ error: "A role is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Security audit finding 2: the role name was never checked against
    // anything — an invite for a role that carries is_admin/can_manage
    // went straight into profiles, the exact escalation path
    // tg_protect_profile_role (0033) closes on the direct-update side.
    // roles_select_org scopes this to the caller's own org already, via
    // userClient (the caller's own JWT), so this can't be used to probe
    // another org's role names.
    const { data: roleRow, error: roleError } = await userClient
      .from("roles")
      .select("is_admin, can_manage")
      .eq("org_id", orgId)
      .eq("name", role)
      .maybeSingle();

    if (roleError) {
      return new Response(JSON.stringify({ error: "Could not verify that role" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!roleRow) {
      return new Response(JSON.stringify({ error: "That role does not exist in your organisation" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (roleRow.is_admin || roleRow.can_manage) {
      const { data: callerIsAdmin, error: callerIsAdminError } = await userClient.rpc("is_admin");
      if (callerIsAdminError || !callerIsAdmin) {
        return new Response(JSON.stringify({ error: "Only an Administrator may assign a manager or admin role" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Managers are location-scoped now: an invite can only assign
    // locations the inviter actually manages (an Administrator manages
    // every org location, so this is a no-op for them). Validated against
    // the submitted ids, not silently filtered, so a rejected id surfaces
    // as an error rather than a silently-dropped assignment.
    const requestedLocationIds: string[] = [
      ...(primaryLocationId ? [primaryLocationId] : []),
      ...(Array.isArray(additionalLocationIds) ? additionalLocationIds : []),
    ];

    if (requestedLocationIds.length > 0) {
      const { data: managedLocationIds, error: managedLocationsError } =
        await userClient.rpc("my_managed_locations");

      if (managedLocationsError) {
        return new Response(JSON.stringify({ error: "Could not verify your managed locations" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const managedSet = new Set<string>(managedLocationIds ?? []);
      const outOfScope = requestedLocationIds.filter((id) => !managedSet.has(id));
      if (outOfScope.length > 0) {
        return new Response(
          JSON.stringify({ error: "You cannot assign a location you do not manage" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const appUrl = (typeof redirectBase === 'string' && redirectBase) ||
      req.headers.get('origin') || '';
    const { data: inviteData, error: inviteError } =
      await adminClient.auth.admin.inviteUserByEmail(email, {
        redirectTo: appUrl,
        // tg_handle_new_user falls back to a hardcoded default org when it
        // finds no org_id here — passing it explicitly is what keeps a
        // new invite in the inviter's own org instead.
        data: { org_id: orgId },
      });

    if (inviteError) {
      return new Response(JSON.stringify({ error: inviteError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const newUserId = inviteData.user.id;

    const { error: profileError } = await adminClient.from("profiles").upsert({
      id: newUserId,
      org_id: orgId,
      role,
      first_name: firstName?.trim() || null,
      full_name: fullName?.trim() || null,
    }, { onConflict: "id" });

    if (profileError) {
      console.error("Profile creation failed:", profileError.message);
    }

    const allLocationIds = [
      ...(primaryLocationId ? [primaryLocationId] : []),
      ...(Array.isArray(additionalLocationIds) ? additionalLocationIds.filter((id: string) => id !== primaryLocationId) : []),
    ];

    if (allLocationIds.length > 0) {
      const rows = allLocationIds.map((locationId: string) => ({
        profile_id: newUserId,
        location_id: locationId,
        is_primary: locationId === primaryLocationId,
        org_id: orgId,
      }));

      const { error: locError } = await adminClient.from("profile_locations").upsert(rows, { onConflict: "profile_id,location_id" });
      if (locError) {
        console.error("Profile locations insert failed:", locError.message);
      }
    }

    return new Response(JSON.stringify({ success: true, userId: newUserId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
