/**
 * routeTypeUtil.ts — classifies a GTFS `route_type` value into a small,
 * mode-agnostic category + display label. Works with any GTFS feed:
 *
 *   - Basic GTFS route_type (0-12) — the original spec's short list.
 *   - Extended GTFS route_type (100-1799) — the "Google extended" hierarchy
 *     used by many real-world feeds (including Melbourne's), where the
 *     HUNDREDS digit indicates the mode family. e.g. Melbourne uses 400 for
 *     "Urban Railway Service" (Metro trains) and 700 for buses, rather than
 *     the basic codes 1/3 you'd see in a minimal feed.
 *
 * Centralising this in one place means gtfsRoute.ts (fallback route colors)
 * and the bottom sheet (mode labels/icons) can never drift out of sync with
 * each other, and adding support for a new region's feed is a one-file change.
 *
 * Reference: https://developers.google.com/transit/gtfs/reference/extended-route-types
 */

export type RouteCategory =
    | 'tram' | 'metro' | 'rail' | 'bus' | 'coach' | 'ferry'
    | 'cable' | 'aerial' | 'funicular' | 'other';

export interface RouteTypeInfo {
    category: RouteCategory;
    label: string;
}

/**
 * Classifies a route_type into a category + human label. Handles both the
 * basic 0-12 codes and the extended 100-1799 hierarchical codes.
 */
export function classifyRouteType(routeType: number): RouteTypeInfo {
    // ── Basic GTFS route_type (0-12) — exact matches ─────────────────────────
    switch (routeType) {
        case 0:  return { category: 'tram',      label: 'Tram' };
        case 1:  return { category: 'metro',     label: 'Metro' };
        case 2:  return { category: 'rail',      label: 'Train' };
        case 3:  return { category: 'bus',       label: 'Bus' };
        case 4:  return { category: 'ferry',     label: 'Ferry' };
        case 5:  return { category: 'cable',     label: 'Cable Car' };
        case 6:  return { category: 'aerial',    label: 'Aerial Lift' };
        case 7:  return { category: 'funicular', label: 'Funicular' };
        case 11: return { category: 'bus',       label: 'Trolleybus' };
        case 12: return { category: 'rail',      label: 'Monorail' };
    }

    // ── Extended GTFS route_type (100-1799) — hundreds digit = mode family ──
    if (routeType >= 100  && routeType < 200)  return { category: 'rail',      label: 'Train' };       // Railway Service
    if (routeType >= 200  && routeType < 300)  return { category: 'coach',     label: 'Coach' };        // Coach Service
    if (routeType >= 300  && routeType < 400)  return { category: 'rail',      label: 'Train' };        // Suburban Railway
    if (routeType >= 400  && routeType < 500)  return { category: 'rail',      label: 'Train' };        // Urban Railway (e.g. Melbourne Metro)
    if (routeType >= 500  && routeType < 600)  return { category: 'metro',     label: 'Metro' };        // Metro Service
    if (routeType >= 600  && routeType < 700)  return { category: 'metro',     label: 'Underground' };  // Underground Service
    if (routeType >= 700  && routeType < 800)  return { category: 'bus',       label: 'Bus' };          // Bus Service
    if (routeType >= 800  && routeType < 900)  return { category: 'bus',       label: 'Trolleybus' };   // Trolleybus Service
    if (routeType >= 900  && routeType < 1000) return { category: 'tram',      label: 'Tram' };         // Tram Service
    if (routeType >= 1000 && routeType < 1100) return { category: 'ferry',     label: 'Water' };        // Water Transport
    if (routeType >= 1100 && routeType < 1200) return { category: 'other',     label: 'Air' };          // Air Service
    if (routeType >= 1200 && routeType < 1300) return { category: 'ferry',     label: 'Ferry' };        // Ferry Service
    if (routeType >= 1300 && routeType < 1400) return { category: 'aerial',    label: 'Aerial Lift' };  // Aerial Lift Service
    if (routeType >= 1400 && routeType < 1500) return { category: 'funicular', label: 'Funicular' };    // Funicular Service
    if (routeType >= 1500 && routeType < 1600) return { category: 'other',     label: 'Taxi' };         // Taxi Service
    if (routeType >= 1700 && routeType < 1800) return { category: 'other',     label: 'Transit' };      // Miscellaneous

    return { category: 'other', label: 'Transit' };
}

/**
 * Fallback colour by category when the feed doesn't supply route_color.
 * Regional/long-distance rail (V/Line-style) gets a distinct colour from
 * urban metro rail — detected by name keywords, since route_type alone
 * can't always distinguish them.
 */
export function fallbackRouteColor(routeType: number, routeName: string): string {
    const { category } = classifyRouteType(routeType);
    const name = routeName.toLowerCase();

    switch (category) {
        case 'tram':  return '#EAB308';
        case 'bus':   return '#F97316';
        case 'ferry': return '#0EA5E9';
        case 'metro': return '#2563EB';
        case 'rail': {
            const regionalHints = [
                'v/line', 'regional', 'albury', 'ballarat', 'bairnsdale', 'bendigo',
                'echuca', 'geelong', 'maryborough', 'shepparton', 'swan hill',
                'traralgon', 'warrnambool', 'seymour',
            ];
            if (regionalHints.some(h => name.includes(h))) return '#8F1A95';
            return '#2563EB';
        }
        case 'coach': return '#8F1A95';
        default:      return '#2563EB';
    }
}