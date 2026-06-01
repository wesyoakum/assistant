import { useEffect, useState } from "react";
import * as ScreenOrientation from "expo-screen-orientation";

export type Orientation = "portrait" | "landscape";

export function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>("portrait");

  useEffect(() => {
    const update = (o: ScreenOrientation.OrientationChangeEvent) => {
      const v = o.orientationInfo.orientation;
      setOrientation(
        v === ScreenOrientation.Orientation.LANDSCAPE_LEFT ||
        v === ScreenOrientation.Orientation.LANDSCAPE_RIGHT
          ? "landscape"
          : "portrait",
      );
    };

    // Read current.
    ScreenOrientation.getOrientationAsync().then((v) => {
      setOrientation(
        v === ScreenOrientation.Orientation.LANDSCAPE_LEFT ||
        v === ScreenOrientation.Orientation.LANDSCAPE_RIGHT
          ? "landscape"
          : "portrait",
      );
    });

    const sub = ScreenOrientation.addOrientationChangeListener(update);
    return () => ScreenOrientation.removeOrientationChangeListener(sub);
  }, []);

  return orientation;
}
