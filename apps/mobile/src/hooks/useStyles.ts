import { useMemo } from "react";
import { useTheme, type Theme } from "../theme";

/**
 * Convenience for theme-aware styles:
 *
 *   const styles = useStyles(makeStyles);
 *   function makeStyles(theme: Theme) { return StyleSheet.create({...}); }
 */
export function useStyles<T>(makeStyles: (theme: Theme) => T): T {
  const theme = useTheme();
  return useMemo(() => makeStyles(theme), [theme, makeStyles]);
}
