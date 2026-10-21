[out:json][timeout:240][bbox:37.517,126.998,37.539,127.028];
(
  way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];
  way[building];
  relation[building];
  way[natural=water];
  way[waterway=riverbank];
  relation[natural=water];
  relation[waterway=riverbank];
  way[leisure~"^(park|garden)$"];
  relation[leisure~"^(park|garden)$"];
  way[landuse~"^(grass|recreation_ground)$"];
  way[railway=rail];
  node[place];
  node[highway=traffic_signals];
);
out body;
>;
out skel qt;