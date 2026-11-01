/**
 * An SVG imported by the client half is a data URL (esbuild's `dataurl` loader, set
 * by this plugin's own build), so it can be handed straight to an `<img src>`.
 */
declare module '*.svg' {
  const url: string
  export default url
}
