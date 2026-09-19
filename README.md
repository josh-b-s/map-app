gtfs zip preprocessed to sql db

graph for bfs gets built with walking distance in consideration

destination and origin using caller's max walking distance to find stops within that radius deduped if on the same 
ride/pattern by taking the closest one there

balanced bidirectional bfs expands on whichever side has the least stops to expand from

when bfs meets it continues at that transit amount + 1 as a margin

all the candidate trips/paths from bfs are traversed with the caller's walking speed and the average ride time between 
stops and average wait time/2 and the top 25% fastest plus a 25% margin is used as a filter for slower ones

the top 25% duration with a 50% margin is used for the time window for the real timetable sql

the verifier runs through those paths with the callers walking speed and calculates the time to get to the first stop 
and takes the earliest one and this continues until the end