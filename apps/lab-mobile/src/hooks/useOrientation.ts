import { useWindowDimensions } from "react-native";

export type Orientation = "portrait" | "landscape";

/** Returns "landscape" when width > height, "portrait" otherwise. */
export function useOrientation(): Orientation {
  const { width, height } = useWindowDimensions();
  return width > height ? "landscape" : "portrait";
}
