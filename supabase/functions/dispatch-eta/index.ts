import { createClient } from "npm:@supabase/supabase-js@2.112.4";

// Mirrors invite-staff's own rate limit: a real, billed API call on every
// invocation, so this needs a floor independent of the client's own
// throttle (ClockInTab calls this roughly every 90s; this is deliberately
// a little under that, not the same number, so ordinary jitter never
// trips it while a client that skipped its own throttle still gets
// capped).
const MIN_SECONDS_BETWEEN_UPDATES = 60;

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
    const mapboxToken = Deno.env.get("MAPBOX_ACCESS_TOKEN");
    if (!mapboxToken) {
      return new Response(JSON.stringify({ error: "Server is not configured for ETA lookups" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Request body must be valid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { message_id, latitude, longitude } = body;

    if (typeof message_id !== "string" || !message_id) {
      return new Response(JSON.stringify({ error: "message_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (typeof latitude !== "number" || latitude < -90 || latitude > 90 ||
        typeof longitude !== "number" || longitude < -180 || longitude > 180) {
      return new Response(JSON.stringify({ error: "A valid latitude/longitude is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Identity via userClient (RLS-scoped, the caller's own JWT) --
    // dispatch_messages_select lets FOH/managers read this row too, so
    // ownership is checked explicitly here, not assumed from a
    // successful read. Same "userClient for identity, adminClient for
    // the privileged write" split as invite-staff.
    const { data: message, error: messageError } = await userClient
      .from("dispatch_messages")
      .select("id, sender_id, status, location_id, updated_at")
      .eq("id", message_id)
      .maybeSingle();

    if (messageError) {
      return new Response(JSON.stringify({ error: "Could not look up that dispatch message" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!message || message.sender_id !== user.id) {
      return new Response(JSON.stringify({ error: "Dispatch message not found or not yours" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (message.status !== "returning" && message.status !== "stale") {
      return new Response(JSON.stringify({ error: "This trip has already been resolved" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const secondsSinceUpdate = (Date.now() - new Date(message.updated_at).getTime()) / 1000;
    if (secondsSinceUpdate < MIN_SECONDS_BETWEEN_UPDATES) {
      return new Response(
        JSON.stringify({ error: `Too soon since the last update. Try again in about ${Math.ceil(MIN_SECONDS_BETWEEN_UPDATES - secondsSinceUpdate)}s.` }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: location, error: locationError } = await adminClient
      .from("locations")
      .select("latitude, longitude")
      .eq("id", message.location_id)
      .single();
    if (locationError || !location) {
      return new Response(JSON.stringify({ error: "Could not determine the store's location" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const directionsUrl =
      `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/` +
      `${longitude},${latitude};${location.longitude},${location.latitude}` +
      `?access_token=${mapboxToken}&overview=false`;

    let etaMinutes: number;
    try {
      const mapboxResponse = await fetch(directionsUrl);
      const mapboxData = await mapboxResponse.json();
      if (mapboxData.code !== "Ok" || !mapboxData.routes?.[0]) {
        return new Response(JSON.stringify({ error: "Could not calculate a route back to the store" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      etaMinutes = Math.max(1, Math.round(mapboxData.routes[0].duration / 60));
    } catch {
      return new Response(JSON.stringify({ error: "Could not reach the ETA service" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // service_role (BYPASSRLS) -- there is no update policy for
    // authenticated at all (see 0040's own header). Also revives a
    // 'stale' message back to 'returning': signal recovered, the ETA is
    // fresh again, no reason to keep showing it as lost.
    const { error: updateError } = await adminClient
      .from("dispatch_messages")
      .update({ status: "returning", eta_minutes: etaMinutes })
      .eq("id", message_id);

    if (updateError) {
      return new Response(JSON.stringify({ error: "Could not save the updated ETA" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, eta_minutes: etaMinutes }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
