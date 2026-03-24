import polyline from "@mapbox/polyline";

export type LatLng = { latitude: number; longitude: number };
export type TravelMode = "DRIVE" | "TRANSIT" | "WALK" | "BICYCLE";

export interface SearchPlace {
    place_id: string;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
}

export interface SearchOptions {
    apiKey: string;
    location?: LatLng; // optional bias
    signal?: AbortSignal;
}

export async function searchPlaces(query: string, opts: SearchOptions): Promise<SearchPlace[]> {
    const {apiKey, location, signal} = opts;
    if (!apiKey) throw new Error("Missing API key");
    if (!query || query.trim().length < 1) return [];

    const url = "https://places.googleapis.com/v1/places:searchText";
    const body: any = {textQuery: query, maxResultCount: 8};
    if (location) {
        body.locationBias = {
            circle: {center: {latitude: location.latitude, longitude: location.longitude}, radius: 50000}
        };
    }

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location"
        },
        body: JSON.stringify(body),
        signal
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    const places = data.places || [];
    return places.map((p: any) => ({
        place_id: p.id,
        name: p.displayName?.text || "Unknown",
        address: p.formattedAddress || "",
        latitude: p.location?.latitude || 0,
        longitude: p.location?.longitude || 0
    }));
}

export interface ComputeRouteResult {
    coords: LatLng[];
    raw: any;
}

export interface ComputeRouteOptions {
    apiKey: string;
    travelMode?: TravelMode;
}

export async function computeRoute(origin: LatLng, destination: LatLng, opts: ComputeRouteOptions): Promise<ComputeRouteResult> {
    const {apiKey, travelMode = "DRIVE"} = opts;
    if (!apiKey) throw new Error("Missing API key");

    const url = "https://routes.googleapis.com/directions/v2:computeRoutes";

    const body: any = {
        origin: {location: {latLng: {latitude: origin.latitude, longitude: origin.longitude}}},
        destination: {location: {latLng: {latitude: destination.latitude, longitude: destination.longitude}}},
        travelMode
    };

    if (travelMode === "TRANSIT") {
        body.transitPreferences = {
            allowedTravelModes: ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL"],
            routingPreference: "FEWER_TRANSFERS"
        };
        body.departureTime = new Date().toISOString();
    }

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "routes.polyline.encodedPolyline"
        },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Routing HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json();

    // Prefer new routes[0].polyline.encodedPolyline, fallback to legacy overview_polyline
    const encoded = data?.routes?.[0]?.polyline?.encodedPolyline || data?.routes?.[0]?.overview_polyline?.points;
    if (!encoded) throw new Error("No polyline returned from routing API");

    const points: number[][] = polyline.decode(encoded); // array of [lat, lng]
    const coords: LatLng[] = points.map(([lat, lng]) => ({latitude: lat, longitude: lng}));
    return {coords, raw: data};
}
