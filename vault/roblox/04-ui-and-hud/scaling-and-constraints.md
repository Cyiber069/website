# UI Scaling And Constraints

> Size and position interface elements with Scale, keep shapes with aspect ratio constraints, and use one UIScale per screen to adapt to resolution.

## Scale versus Offset

A `UDim2` has a Scale part (fraction of the parent) and an Offset part (pixels).

- **Position and size containers with Scale.** Why: a panel set to 300 pixels wide is tiny on a 4K monitor and huge on a small phone.
- **Use Offset only for small fixed details** such as padding or stroke thickness, and expect them to be multiplied by a `UIScale`.
- **Set `AnchorPoint` to match the edge an element hugs.** A right-edge button uses an anchor of (1, 0.5) and a position of (1, 0, 0.5, 0) minus padding. Why: the element stays attached to its edge at any size.

## Constraints

- **`UIAspectRatioConstraint`** keeps a frame's width-to-height ratio. Put it on square buttons, icons and panels sized by Scale. Why: Scale on both axes stretches a square into a rectangle when the screen shape changes.
- **`UISizeConstraint`** sets minimum and maximum pixel size. Why: it stops a panel from becoming unusably small on phones or absurdly large on ultrawide monitors.
- **`UITextSizeConstraint`** with `TextScaled` bounds text between a minimum and maximum size. Why: unconstrained scaled text becomes microscopic in short labels' neighbours and giant in big ones.
- **`UIListLayout`, `UIGridLayout`, `UIPadding`** arrange children. Why: manual positions break when one item is added or hidden.

## One UIScale per screen

Design at a reference resolution, then scale the whole screen by the ratio of the real viewport to the reference.

```lua
local camera = workspace.CurrentCamera
local REFERENCE = Vector2.new(1280, 720)

local function updateScale(uiScale: UIScale)
	local size = camera.ViewportSize
	local ratio = math.min(size.X / REFERENCE.X, size.Y / REFERENCE.Y)
	uiScale.Scale = math.clamp(ratio, 0.6, 1.5)
end

camera:GetPropertyChangedSignal("ViewportSize"):Connect(function()
	updateScale(script.Parent.UIScale)
end)
```

Why the minimum of both axes: it guarantees the design fits in the shorter dimension, which on a landscape phone is height. Why clamp: below a floor, text becomes unreadable, so it is better to let a panel take more of the screen than to shrink further.

## Text

- Prefer short labels and icons with numbers. Why: long strings do not fit and many players do not read them.
- Check the longest value a label can hold, such as an abbreviated currency amount from [[Soft And Hard Currencies]].
- Give text a stroke or a solid backing when it sits over the 3D world. Why: world colours change behind it; see [[Lighting And Readability]].

## Verify

Check every screen in the device emulator at a small phone, a tablet and a wide desktop size. Placement rules are in [[Mobile-First HUD Zones]].

## Check before you hand off

- No container uses pixel Offset for its main size or position.
- Square and icon elements carry a `UIAspectRatioConstraint`.
- Scaled text has minimum and maximum sizes.
- A `UIScale` responds to viewport size changes, including device rotation.
- Screens were viewed at three device sizes with no clipping or overlap.
