# Blixt interface

The existing dark identity is retained for users glancing between the weather map and its controls, on a mobile device or desktop. Dark opaque panels keep text legible over both dark and light basemaps.

- System sans-serif; body and controls at 14 px or larger, notes at 12 px or larger.
- Restrained blue-tinted neutral surfaces and pale blue selected states. Weather colors retain their existing data meanings.
- Shared panel, border, radius and spacing tokens in `src/style.css`; clear focus outlines and 44 px minimum controls.
- Desktop: status at top, explanation at upper right, layers at lower right, zoom/location at upper left.
- Compact layout at width <=900 px or height <=500 px: two bottom buttons open mutually exclusive, scrollable panels capped at 45dvh.
- Account for safe-area insets, attribution and popup visibility. Keep transitions short; honor reduced motion.
