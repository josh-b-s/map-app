import {Platform, StyleSheet} from "react-native";

export const styles = StyleSheet.create({
    myLocationBtn: {
        position: "absolute",
        bottom: 20,
        right: 20,
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: "white",
        alignItems: "center",
        justifyContent: "center",
        elevation: 4
    },
    searchContainer: {position: "absolute", top: Platform.OS === "ios" ? 60 : 40, left: 16, right: 16, zIndex: 1000},
    searchBar: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "white",
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        elevation: 5
    },
    searchIcon: {marginRight: 8},
    searchInput: {flex: 1, fontSize: 16, color: "#333"},
    clearButton: {padding: 6, marginLeft: 6},
    searchResultsContainer: {backgroundColor: "white", borderRadius: 12, marginTop: 8, maxHeight: 300, elevation: 5},
    searchResultItem: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: "#f0f0f0"
    },
    searchResultContent: {flex: 1},
    searchResultName: {fontSize: 16, fontWeight: "600", color: "#333", marginBottom: 2},
    searchResultAddress: {fontSize: 14, color: "#666"}
});
