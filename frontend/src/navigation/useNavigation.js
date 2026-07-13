// -----------------------------------------------------------------------------
// useNavigation.js — GPS watch + navigation state machine (Phase 1).
//
// States: idle → preview (route ready) → navigating
// -----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { cancelSpeech } from "./voiceGuidance.js";
import { resolveHeading } from "./snapToRoute.js";

const WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 1000,
  timeout: 10000,
};

const NAV_ZOOM = 17;
const NAV_PITCH = 50;
const CAMERA_THROTTLE_MS = 900;

export function useNavigation({ mapRef, userMarkerRef, userLocationRef }) {
  const [navState, setNavState] = useState("idle");
  const [navError, setNavError] = useState(null);
  const watchIdRef = useRef(null);
  const lastFixRef = useRef(null);
  const lastCameraAtRef = useRef(0);

  const isNavigating = navState === "navigating";

  const stopWatch = useCallback(() => {
    if (watchIdRef.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const resetCamera = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
  }, [mapRef]);

  const followCamera = useCallback(
    (lng, lat, heading) => {
      const map = mapRef.current;
      if (!map) return;
      const now = Date.now();
      if (now - lastCameraAtRef.current < CAMERA_THROTTLE_MS) return;
      lastCameraAtRef.current = now;

      const opts = {
        center: [lng, lat],
        zoom: Math.max(map.getZoom(), NAV_ZOOM),
        pitch: NAV_PITCH,
        duration: 750,
      };
      if (heading != null) opts.bearing = heading;
      map.easeTo(opts);
    },
    [mapRef],
  );

  const applyPosition = useCallback(
    (lng, lat, heading) => {
      userLocationRef.current = { lng, lat };
      userMarkerRef.current?.setLngLat([lng, lat]);
      followCamera(lng, lat, heading);
    },
    [userLocationRef, userMarkerRef, followCamera],
  );

  const handlePosition = useCallback(
    (pos) => {
      const { longitude: lng, latitude: lat, heading: gpsHeading } = pos.coords;
      const prev = lastFixRef.current;
      const heading = resolveHeading(gpsHeading, prev, { lng, lat });
      lastFixRef.current = { lng, lat };
      applyPosition(lng, lat, heading);
      setNavError(null);
    },
    [applyPosition],
  );

  const endNavigation = useCallback(() => {
    stopWatch();
    cancelSpeech();
    lastFixRef.current = null;
    lastCameraAtRef.current = 0;
    setNavError(null);
    setNavState((s) => (s === "navigating" ? "preview" : s));
    resetCamera();
  }, [stopWatch, resetCamera]);

  const startNavigation = useCallback(() => {
    if (!navigator.geolocation) {
      setNavError("Geolocation is not supported in this browser.");
      return false;
    }
    setNavError(null);
    setNavState("navigating");
  }, []);

  // Start / stop watchPosition when entering / leaving navigating state.
  useEffect(() => {
    if (!isNavigating) {
      stopWatch();
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      handlePosition,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setNavError("Location access denied — navigation needs GPS.");
        } else if (err.code === err.TIMEOUT) {
          setNavError("GPS signal lost — trying again…");
        } else {
          setNavError("Couldn't track your location.");
        }
        setNavState("preview");
      },
      WATCH_OPTIONS,
    );

    // Immediate camera jump if we already have a cached fix.
    if (userLocationRef.current) {
      const { lng, lat } = userLocationRef.current;
      const map = mapRef.current;
      map?.easeTo({
        center: [lng, lat],
        zoom: NAV_ZOOM,
        pitch: NAV_PITCH,
        duration: 600,
      });
      userMarkerRef.current?.setLngLat([lng, lat]);
    }

    return stopWatch;
  }, [
    isNavigating,
    handlePosition,
    stopWatch,
    mapRef,
    userLocationRef,
    userMarkerRef,
  ]);

  // Sync preview/idle with whether a route is on screen (caller sets via setNavState).
  useEffect(() => () => stopWatch(), [stopWatch]);

  return {
    navState,
    setNavState,
    isNavigating,
    navError,
    setNavError,
    startNavigation,
    endNavigation,
  };
}
