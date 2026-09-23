import { createClient } from "npm:@supabase/supabase-js@2.112.4";

// This function sends a real email through Resend on every successful
// call, with no cap otherwise -- callable in a loop by any manager/admin
// session, usable as a mass-mail relay. Generous for real onboarding (60
// staff over a few days is well within both), low enough that abuse is
// capped fast. Change here if the real-world onboarding pace changes.
const MAX_INVITES_PER_SENDER_PER_HOUR = 20;
const MAX_INVITES_PER_ORG_PER_DAY = 100;

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

    // Rate limits, checked last, right before the call that actually
    // sends mail -- a request that fails validation above never counts
    // against either cap, since it never sends anything.
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    const { count: senderCount, error: senderCountError } = await adminClient
      .from("invite_log")
      .select("id", { count: "exact", head: true })
      .eq("sender_id", user.id)
      .gte("created_at", hourAgo);

    if (senderCountError) {
      return new Response(JSON.stringify({ error: "Could not verify your invite rate" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if ((senderCount ?? 0) >= MAX_INVITES_PER_SENDER_PER_HOUR) {
      const { data: oldest } = await adminClient
        .from("invite_log")
        .select("created_at")
        .eq("sender_id", user.id)
        .gte("created_at", hourAgo)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      const waitMinutes = oldest
        ? Math.max(1, Math.ceil((new Date(oldest.created_at).getTime() + 60 * 60 * 1000 - now) / 60000))
        : 60;
      return new Response(
        JSON.stringify({ error: `You've sent ${MAX_INVITES_PER_SENDER_PER_HOUR} invites in the last hour. Try again in about ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}.` }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { count: orgCount, error: orgCountError } = await adminClient
      .from("invite_log")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", dayAgo);

    if (orgCountError) {
      return new Response(JSON.stringify({ error: "Could not verify your organisation's invite rate" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if ((orgCount ?? 0) >= MAX_INVITES_PER_ORG_PER_DAY) {
      const { data: oldest } = await adminClient
        .from("invite_log")
        .select("created_at")
        .eq("org_id", orgId)
        .gte("created_at", dayAgo)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      const waitMinutes = oldest
        ? Math.max(1, Math.ceil((new Date(oldest.created_at).getTime() + 24 * 60 * 60 * 1000 - now) / 60000))
        : 24 * 60;
      return new Response(
        JSON.stringify({ error: `Your organisation has sent ${MAX_INVITES_PER_ORG_PER_DAY} invites in the last 24 hours. Try again in about ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}.` }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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

    // Logged as soon as the email is actually sent, independent of
    // whether the profile/location upserts below succeed -- this row is
    // what the rate limit above counts against, so it must reflect real
    // sends, not a fully-completed invite.
    const { error: logError } = await adminClient
      .from("invite_log")
      .insert({ org_id: orgId, sender_id: user.id, email_sent_to: email });
    if (logError) {
      console.error("Invite log insert failed:", logError.message);
    }

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
