gtfs zip preprocessed to sql db of pure timetable and per line ride time estimate + wait time

graph for bfs gets built with walking distance in consideration and it is a per unique line not per differing pattern
graph

destination and origin using caller's max walking distance to find stops within that radius deduped if on the same 
ride/pattern by taking the closest one there

balanced bidirectional bfs expands on whichever side has the least stops to expand from and each transit 
to find stops within that radius deduped if on the same ride/pattern by taking the closest one there similar to seed stops

when bfs meets it continues at that transit amount + 1 as a margin

all the candidate trips/paths from bfs are traversed with the caller's walking speed and the average ride time between 
stops and average wait time/2 and the top 30 fastest is used

the 5th fastest with a 25% margin is used for the time window for the real timetable sql

The edge corridor. After the seed paths, the BFS also collects every edge within the level margin. The patterns loaded for RAPTOR are the seed paths' patterns plus those edge-corridor patterns. Your logs show the returned journey always includes patterns outside the seed paths.

Loader filters. Patterns with no trip today are dropped, then the headway filter and the cap apply.

Time corridor. Right now it runs in parallel and only logs a comparison. The window also has a 10-minute floor and an 8-hour cap.

Raptor search on the filtered everything 

#fallback
the verifier runs through those paths with the callers walking speed and calculates the time to get to the first stop 
and takes the earliest one and this continues until the end