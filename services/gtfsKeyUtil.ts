/**
 * gtfsKeyUtil.ts — composite (agency, id) key helpers used throughout the
 * GTFS loader/router (stop keys, pattern keys, trip keys, etc).
 *
 * THE BUG THIS FIXES: many real-world GTFS feeds use ids that themselves
 * contain colons — e.g. Melbourne's stop_id "vic:rail:CFD", or a pattern_id
 * built from a route_id like "aus:vic:vic-02-CBE:_1". If a composite key is
 * built as `${id}:${agency}` and later parsed with `.split(':')[0]` /
 * `.split(':')[1]`, that split happens on EVERY colon in the string — for
 * "2_aus:vic:vic-02-CBE:_1_b7cdc080:2" this silently returns "2_aus" instead
 * of the real pattern_id, which then fails to match anything downstream.
 * This is exactly why train patterns were vanishing after passing every
 * earlier filter correctly.
 *
 * THE FIX: put agency FIRST (agency is always a plain integer — guaranteed
 * to contain no colons) and parse by locating only the FIRST colon. Whatever
 * follows it is the id, colons and all, taken as-is — never split further.
 */

export function makeKey(agency: number, id: string): string {
    return `${agency}:${id}`;
}

export function parseKey(key: string): { agency: number; id: string } {
    const idx = key.indexOf(':');
    return {agency: Number(key.slice(0, idx)), id: key.slice(idx + 1)};
}
