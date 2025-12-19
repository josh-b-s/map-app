import {useColorScheme} from "nativewind";
import {EdgeInsets} from "react-native-safe-area-context";

export function useThemeStyle() {
    const {colorScheme} = useColorScheme();

    return {
        backgroundColor: colorScheme === "dark" ? "#374151" : "#ffffff", // gray-700
        color: colorScheme === "dark" ? "#ffffff" : "#000000",
    };
}

export const SHADOW = {
    boxShadow: "0px 4px 20px rgba(0,0,0,0.75)",
};

export const TOP_SAFE = (insets: EdgeInsets) => {
    return insets.top + 12   // status bar + camera
}