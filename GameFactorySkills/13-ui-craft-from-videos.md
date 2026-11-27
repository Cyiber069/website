# UI Craft From Videos
> How to make Roblox UI look and feel polished, distilled from eight creator videos the owner chose.

## When to use
- Building or restyling any HUD, shop, panel or button set.
- Briefing an AI to produce UI from a reference image.
- Reviewing UI before it goes to the owner.

## Rules
1. Size and place everything with Scale and leave Offset at 0.
   Why: Offset is fixed pixels and breaks on other screens. [videos 1, 7]
2. Centre with AnchorPoint 0.5, 0.5 and Position 0.5, 0.5, and position children relative to their parent.
   Why: the element stays put when the screen changes shape. [video 1]
3. Lock the shape of buttons and panels with UIAspectRatioConstraint.
   Why: scaled text and icons stop stretching. [video 1]
4. Check phone and tablet sizes while building, not at the end.
   Why: layout faults are cheap to fix early. [videos 1, 3]
5. Give depth with a three-part recipe: a face that is lighter at the top, a darker copy shifted down behind it, and one dark outline.
   Why: flat fills read as unfinished. [videos 4, 6]
6. Add a thin inner highlight in a lighter shade of the fill.
   Why: it makes edges catch the light. [videos 4, 6, 8]
7. Make text white and chunky with a thick dark outline via UIStroke, plus a hard drop shadow.
   Why: it stays readable over any background. [videos 1, 4, 6]
8. Use one rounded, playful font across the game.
   Why: mixed fonts look assembled from parts. [videos 1, 4]
9. Keep outline weight consistent between similar elements and let it scale with the element.
   Why: uneven strokes are the fastest tell of rushed UI. [videos 1, 6]
10. Keep panel backgrounds neutral and reserve strong colour for buttons.
    Why: the eye goes to what can be pressed. [videos 4, 6]
11. Colour-code buttons by job and never break the code: buy is green with a currency icon.
    Why: players learn the meaning once. [videos 4, 6]
12. Lay out a shop with one large featured item first, then smaller cards, each with title, one-line effect, big image and price button.
    Why: hierarchy tells players what matters. [videos 4, 6]
13. Use equal padding on all sides and equal gaps between cards, measured, not judged by eye.
    Why: uneven spacing reads as broken. [video 6]
14. Every button grows slightly on hover and gives a press and release response; animate as a percentage of a stored base size.
    Why: pixel-based tweens drift when sizes change. [videos 7, 8, 3]
15. Open panels with a short fade and slide.
    Why: instant pops feel cheap. [video 7]
16. Build it natively in Studio when Studio can reproduce the design; bake an image only for static, effect-heavy art.
    Why: native UI scales cleanly and baked images can look soft. [videos 7, 1, 4]
17. Keep text that changes or can be pressed as real TextLabels; separate clickable parts from the panel image.
    Why: each part can then update and animate on its own. [videos 7, 2]
18. Icons get a transparent background and a thick outline, and are judged at their real on-screen size.
    Why: detail that works large vanishes small. [videos 1, 6, 4]
19. Use the standard HUD skeleton: currency pill with a plus button, a column of square icon buttons, action buttons top centre, panels opened from those.
    Why: players already know it. [videos 1, 6, 8]
20. When an AI builds UI, give it reference screenshots plus exact colours and fonts, then run build, screenshot, compare, fix. Never ship the first output.
    Why: one-shot results looked right in demos but needed retries in practice. [videos 3, 5, 2]
21. Build one component well, then duplicate and recolour it for the rest of the set.
    Why: consistency comes free. [videos 1, 2, 3, 6]
22. Every keyboard action also needs a touch button.
    Why: most players are on phones. [video 5]

## Checklist
- [ ] No Offset sizing anywhere; shapes locked with aspect ratio constraints.
- [ ] Checked on a small phone, a tablet and a desktop size.
- [ ] Buttons have depth, inner highlight, outline, hover and press response.
- [ ] One font; outline weights consistent.
- [ ] Shop has a featured item and measured spacing.
- [ ] Changing text is real text, not baked into an image.
- [ ] Colour code for button jobs is written in Config and followed.
- [ ] Compared against the reference screenshot at least twice.

## Sources
Eight YouTube videos supplied by the owner, studied from their spoken transcripts only (the picture was not available). Video 5, a two-hour course, was only partly read. Videos 2, 3 and 8 mainly promote a paid UI generator or a download; only the general technique was kept.
Where the videos disagree (native versus baked images, one prompt versus iteration), rules 16 and 20 record the position the evidence supports.

## Lessons from launched games
Add dated lessons here after each launch.
