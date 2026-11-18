# B-roll choice and anti-slop

Scoring in suggest_broll (for reading its reasons):
- keyword: Vision labels and file-name words against the phrase (lemmas, small synonym groups;
  synonyms only against labels). Abstract words (information, access, structure) never match.
- quality: sharpness, exposure, faces (penalised), shake, busy frames, graphics/title cards.
- motion fit vs words per second; duration fit for a 2-5 s hold; palette continuity with the A-roll.
- greedy choice, best first, each shot used once, at least 3 s between cutaways.

Anti-slop checklist before calling place_clips:
- Would a viewer name the same subject as the line? If not, drop it.
- Is it generic stock (smiling business people, handshake, globe, light leaks)? Drop it.
- Does it carry a logo, watermark, burned-in text or a face talking? Drop it.
- Does it clash in colour or era with the neighbouring cutaways? Re-pick or grade.
- Do two cutaways in a row come from the same clip? Fine if continuous action, else vary.
- Is it the first line or the punchline? Stay on the speaker.
