import { useEffect, useState } from "react";

export type Scheme = "light" | "dark";

function readScheme(): Scheme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** The site's color scheme, which the docs page copies onto the demo frame's root. */
export function useSiteScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>("dark");
  useEffect(() => {
    setScheme(readScheme());
    const watch = new MutationObserver(() => setScheme(readScheme()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  return scheme;
}

export const DEMO_FONTS = {
  nameFont: '600 11.5px "Inter", system-ui, sans-serif',
  captionFont: '10.5px "Inter", system-ui, sans-serif',
  markerFont: '700 10px "Inter", system-ui, sans-serif',
} as const;
