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
    location?: LatLng;
    signal?: AbortSignal;
}

export async function searchPlaces(query: string, opts: SearchOptions): Promise<SearchPlace[]> {
    const { apiKey, location, signal } = opts;
    if (!apiKey) throw new Error("Missing API key");
    if (!query.trim()) return [];

    const body: any = { textQuery: query, maxResultCount: 8 };
    if (location) {
        body.locationBias = {
            circle: { center: { latitude: location.latitude, longitude: location.longitude }, radius: 50000 }
        };
    }

    const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
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
    return (data.places ?? []).map((p: any) => ({
        place_id: p.id,
        name: p.displayName?.text ?? "Unknown",
        address: p.formattedAddress ?? "",
        latitude: p.location?.latitude ?? 0,
        longitude: p.location?.longitude ?? 0,
    }));
}