import { configureStore } from '@reduxjs/toolkit';
import searchReducer from './search.slice';
import locationReducer from './location.slice';
import routeReducer from './route.slice';
import debugReducer from './debug.slice';

export const store = configureStore({
    reducer: {
        search: searchReducer,
        location: locationReducer,
        route: routeReducer,
        debug: debugReducer,
    },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
