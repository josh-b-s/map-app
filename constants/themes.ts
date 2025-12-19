import {useColorScheme} from "nativewind";

export function useThemeStyle() {
    const {colorScheme} = useColorScheme();

    return {
        backgroundColor: colorScheme === "dark" ? "#374151" : "#ffffff", // gray-700
        color: colorScheme === "dark" ? "#ffffff" : "#000000",
    };
}

export const FLOATING_SHADOW = {
    elevation: 9,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
};



export const ICON_COLORS = {
    light: "#000000",
    dark: "#ffffff",
};


export const useColor = () => {
    const {colorScheme} = useColorScheme();
    return ICON_COLORS[colorScheme ?? "light"];
}
