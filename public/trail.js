/* Mini map trail: a few polylines instead of one marker per step,
   so long rides keep a bounded number of map objects. */
import { MAX_SEGMENT_M, distMeters, splitSegments } from "./geo.js";

const TRAIL_JOIN_M = 1; // extend the last polyline when the new segment starts this close to its tail

export function createTrail(map) {
  let polylines = [];

  function add(path) {
    polylines.push(new google.maps.Polyline({
      path,
      strokeColor: "#2563eb",
      strokeOpacity: 0.8,
      strokeWeight: 4,
      clickable: false,
      map,
    }));
  }

  function reset(points) {
    polylines.forEach((pl) => pl.setMap(null));
    polylines = [];
    for (const path of splitSegments(points)) add(path);
  }

  function extend(from, to) {
    const path = polylines[polylines.length - 1]?.getPath();
    const tail = path && path.getLength() ? path.getAt(path.getLength() - 1) : null;
    const tailPos = tail ? { lat: tail.lat(), lng: tail.lng() } : null;
    if (tailPos && distMeters(tailPos, from) <= TRAIL_JOIN_M && distMeters(from, to) <= MAX_SEGMENT_M) {
      path.push(new google.maps.LatLng(to.lat, to.lng));
    } else {
      add([from, to]);
    }
  }

  return { reset, extend };
}
