import { useCallback, useEffect, useMemo, useState } from 'react';
import { Circle, MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { ChevronDown, Compass, Gauge, Loader2, MapPin, RefreshCw, Truck } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../supabaseClient';

// Drivers ping every 90s, so anything older than 5 minutes is cold.
const STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_CENTER = [51.6, 0.25]; // Essex — the three sites sit inside this
const DEFAULT_ZOOM = 10;
const SITE_ZOOM = 15;

/*
 * Tailwind scans source files for literal class strings. DivIcon markup is
 * built outside React, so every class must appear here as a complete literal —
 * never assembled as `bg-${color}`, which the scanner cannot see and which
 * would ship an unstyled pin.
 */
const MARKER_THEME = {
  onDuty: {
    pill: 'bg-secondary text-white ring-secondary/30',
    pin: 'bg-secondary ring-white',
    stem: 'bg-secondary',
    swatch: 'bg-secondary',
  },
  offDuty: {
    pill: 'bg-border text-ink ring-border',
    pin: 'bg-border ring-white',
    stem: 'bg-border',
    swatch: 'bg-border',
  },
};

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatSpeed(metersPerSecond) {
  if (metersPerSecond == null) return 'Not moving';
  const kph = metersPerSecond * 3.6;
  if (kph < 2) return 'Stationary';
  return `${Math.round(kph)} km/h`;
}

function formatHeading(degrees) {
  if (degrees == null) return '—';
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${points[Math.round(degrees / 45) % 8]} · ${Math.round(degrees)}°`;
}

function buildIcon({ label, theme, heading, onDuty }) {
  const arrow =
    onDuty && heading != null
      ? `<span class="absolute inset-0 flex items-start justify-center" style="transform: rotate(${Number(heading)}deg)">
           <span class="mt-[-5px] h-0 w-0 border-x-[4px] border-b-[6px] border-x-transparent border-b-white"></span>
         </span>`
      : '';

  return L.divIcon({
    className: '',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    popupAnchor: [0, -34],
    html: `
      <div class="absolute -translate-x-1/2 -translate-y-full flex flex-col items-center">
        <span class="max-w-[7rem] truncate rounded-full px-2.5 py-1 text-xs font-semibold shadow-sm ring-1 ${theme.pill}">
          ${escapeHtml(label)}
        </span>
        <span class="h-2 w-0.5 ${theme.stem}"></span>
        <span class="relative flex h-4 w-4 items-center justify-center rounded-full shadow ring-2 ${theme.pin}">
          ${arrow}
        </span>
      </div>
    `,
  });
}

function MapController({ target, bounds }) {
  const map = useMap();

  useEffect(() => {
    const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (target) {
      if (instant) map.setView([target.latitude, target.longitude], SITE_ZOOM);
      else map.flyTo([target.latitude, target.longitude], SITE_ZOOM, { duration: 0.8 });
      return;
    }

    if (bounds?.length) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.25), { animate: !instant });
    }
  }, [target, bounds, map]);

  return null;
}

export default function LiveMap({ height = '100%' }) {
  const [sites, setSites] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState('all');
  const [drivers, setDrivers] = useState([]); // [{ position, profile, shift }]
  const [duty, setDuty] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [, forceTick] = useState(0);

  // Keeps the "x min ago" strings honest between refreshes.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  /*
   * Deliberately manual. Positions are only meaningful when someone is
   * actually looking, so a realtime subscription would burn quota keeping
   * markers current for an empty screen.
   */
  const refresh = useCallback(async () => {
    setLoading(true);

    const [liveResult, dutyResult] = await Promise.all([
      supabase
        .from('live_locations')
        .select(
          'user_id, latitude, longitude, heading, speed, accuracy, updated_at, profiles ( id, first_name, full_name, role )'
        ),
      supabase.from('time_logs').select('user_id, location_id, clock_in').is('clock_out', null),
    ]);

    const openLogs = Object.fromEntries((dutyResult.data ?? []).map((row) => [row.user_id, row]));
    setDuty(openLogs);

    // Only drivers are tracked. Everyone else works on site, so their
    // position tells a manager nothing the roster does not already say.
    setDrivers(
      (liveResult.data ?? [])
        .filter((row) => row.profiles?.role === 'Driver')
        .map((row) => ({ position: row, profile: row.profiles, shift: openLogs[row.user_id] ?? null }))
    );

    setRefreshedAt(new Date().toISOString());
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from('locations')
        .select('id, name, address, latitude, longitude, radius_meters')
        .eq('is_active', true)
        .order('name');

      if (cancelled) return;
      setSites(data ?? []);
      await refresh();
    })();

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const selectedSite = useMemo(
    () => (selectedSiteId === 'all' ? null : (sites.find((s) => s.id === selectedSiteId) ?? null)),
    [sites, selectedSiteId]
  );

  const markers = useMemo(() => {
    const now = Date.now();

    return drivers
      .map(({ position, profile, shift }) => {
        const stale = now - new Date(position.updated_at).getTime() > STALE_AFTER_MS;
        const onDuty = Boolean(shift) && !stale;
        return {
          position,
          profile,
          shift,
          onDuty,
          stale,
          theme: onDuty ? MARKER_THEME.onDuty : MARKER_THEME.offDuty,
        };
      })
      // Off duty means the position is stale or the shift is over.
      // Showing it would imply a driver is out when they are not.
      .filter(({ onDuty }) => onDuty)
      .filter(({ shift }) => selectedSiteId === 'all' || shift?.location_id === selectedSiteId);
  }, [drivers, selectedSiteId, duty]);

  const bounds = useMemo(() => {
    const points = markers.map((m) => [m.position.latitude, m.position.longitude]);
    if (points.length) return points;
    return sites.map((s) => [s.latitude, s.longitude]);
  }, [markers, sites]);

  const onDutyCount = markers.filter((m) => m.onDuty).length;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="relative">
          <select
            value={selectedSiteId}
            onChange={(event) => setSelectedSiteId(event.target.value)}
            aria-label="Filter map by location"
            className="min-h-[44px] appearance-none rounded-lg border border-border bg-surface py-2 pl-9 pr-9 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <option value="all">All locations</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
          <MapPin
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50"
            aria-hidden="true"
          />
          <ChevronDown
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50"
            aria-hidden="true"
          />
        </div>

        <div className="flex items-center gap-1.5 text-sm text-ink/80">
          <Truck className="h-4 w-4 text-ink/50" aria-hidden="true" />
          <span className="font-medium tabular-nums text-ink">{onDutyCount}</span>
          <span className="hidden sm:inline">on the road</span>
        </div>

        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="ml-auto inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          Refresh
        </button>
      </div>

      {refreshedAt && (
        <p className="border-b border-border px-4 py-1.5 text-xs text-ink/50">
          Positions as of {relativeTime(refreshedAt)}. Drivers only.
        </p>
      )}

      {/* Map */}
      <div className="relative flex-1" style={{ height }}>
        <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} scrollWheelZoom className="h-full w-full">
          <TileLayer
            url="https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=Z9cNYGdzYdzYthbFh0b1"
            attribution='&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            maxZoom={18}
          />

          <MapController target={selectedSite} bounds={selectedSite ? null : bounds} />

          {selectedSite && (
            <Circle
              center={[selectedSite.latitude, selectedSite.longitude]}
              radius={selectedSite.radius_meters}
              pathOptions={{ color: '#14532D', weight: 1, fillColor: '#14532D', fillOpacity: 0.06 }}
            />
          )}

          {markers.map(({ position, profile, onDuty, stale, theme }) => (
            <Marker
              key={position.user_id}
              position={[position.latitude, position.longitude]}
              icon={buildIcon({
                label: profile?.first_name ?? 'Driver',
                theme,
                heading: position.heading,
                onDuty,
              })}
              zIndexOffset={onDuty ? 400 : 0}
            >
              <Popup>
                <div className="min-w-[13rem] font-sans">
                  <p className="text-sm font-semibold text-ink">
                    {profile?.full_name ?? profile?.first_name ?? 'Unknown driver'}
                  </p>
                  <p className="mt-0.5 text-xs text-ink/60">
                    Driver
                    {!onDuty && <span className="ml-1 text-ink/40">· Off duty</span>}
                  </p>

                  <dl className="mt-3 space-y-1.5 text-xs">
                    <div className="flex items-center gap-2 text-ink/80">
                      <Gauge className="h-3.5 w-3.5 text-ink/50" aria-hidden="true" />
                      <dt className="sr-only">Speed</dt>
                      <dd className="tabular-nums">{formatSpeed(position.speed)}</dd>
                    </div>
                    <div className="flex items-center gap-2 text-ink/80">
                      <Compass className="h-3.5 w-3.5 text-ink/50" aria-hidden="true" />
                      <dt className="sr-only">Heading</dt>
                      <dd className="tabular-nums">{formatHeading(position.heading)}</dd>
                    </div>
                  </dl>

                  <p
                    className={`mt-3 border-t border-border pt-2 text-xs ${stale ? 'text-warning' : 'text-ink/50'}`}
                  >
                    Last ping {relativeTime(position.updated_at)}
                    {position.accuracy != null && ` · ±${Math.round(position.accuracy)} m`}
                  </p>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>

        {!loading && markers.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
            <p className="rounded-full bg-primary/90 px-4 py-2 text-xs font-medium text-white">
              {selectedSite ? `No drivers out from ${selectedSite.name}` : 'No drivers on the road'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
