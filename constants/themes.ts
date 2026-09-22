import { useColorScheme } from 'nativewind';
import { EdgeInsets } from 'react-native-safe-area-context';

export function useThemeStyle() {
    const { colorScheme } = useColorScheme();
    const dark = colorScheme === 'dark';
    return {
        backgroundColor: dark ? '#374151' : '#ffffff',
        color: dark ? '#ffffff' : '#000000',
        // A step darker than backgroundColor in both modes — for surfaces
        // that need to visually separate from the sheet/card they sit on
        // (inactive pills, chips) instead of blending flat into it.
        surfaceColor: dark ? '#1f2937' : '#e5e7eb',
    };
}

export const SHADOW = {
    boxShadow: '0px 4px 20px rgba(0,0,0,0.75)',
};

export const TOP_SAFE = (insets: EdgeInsets) => insets.top + 12;

// constants/mapStyles.ts
import { MapStyleElement } from 'react-native-maps';

export const MAP_STYLE_DARK: MapStyleElement[] = [
    { elementType: 'geometry',                     stylers: [{ color: '#242f3e' }] },
    { elementType: 'labels.text.stroke',           stylers: [{ color: '#242f3e' }] },
    { elementType: 'labels.text.fill',             stylers: [{ color: '#746855' }] },
    { featureType: 'administrative.locality',      elementType: 'labels.text.fill',   stylers: [{ color: '#d59563' }] },
    { featureType: 'poi',                          elementType: 'labels.text.fill',   stylers: [{ color: '#d59563' }] },
    { featureType: 'poi.park',                     elementType: 'geometry',            stylers: [{ color: '#263c3f' }] },
    { featureType: 'poi.park',                     elementType: 'labels.text.fill',   stylers: [{ color: '#6b9a76' }] },
    { featureType: 'road',                         elementType: 'geometry',            stylers: [{ color: '#38414e' }] },
    { featureType: 'road',                         elementType: 'geometry.stroke',    stylers: [{ color: '#212a37' }] },
    { featureType: 'road',                         elementType: 'labels.text.fill',   stylers: [{ color: '#9ca5b3' }] },
    { featureType: 'road.highway',                 elementType: 'geometry',            stylers: [{ color: '#746855' }] },
    { featureType: 'road.highway',                 elementType: 'geometry.stroke',    stylers: [{ color: '#1f2835' }] },
    { featureType: 'road.highway',                 elementType: 'labels.text.fill',   stylers: [{ color: '#f3d19c' }] },
    { featureType: 'transit',                      elementType: 'geometry',            stylers: [{ color: '#2f3948' }] },
    { featureType: 'transit.station',              elementType: 'labels.text.fill',   stylers: [{ color: '#d59563' }] },
    { featureType: 'water',                        elementType: 'geometry',            stylers: [{ color: '#17263c' }] },
    { featureType: 'water',                        elementType: 'labels.text.fill',   stylers: [{ color: '#515c6d' }] },
    { featureType: 'water',                        elementType: 'labels.text.stroke', stylers: [{ color: '#17263c' }] },
];