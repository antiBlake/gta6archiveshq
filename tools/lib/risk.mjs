// Rule-based safety check (no AI). A draft with no reasons is auto-approved and published at its slot;
// anything flagged goes to Telegram for the owner's ✅/❌.
// Owner rule since 2026-11-20: "auto approve all posts and only send posts you're not sure is violating".

const RULES = [
  [/\bleak(ed|s)?\b|early access|play (it )?early|pirat|crack(ed)?|free download|torrent/i, 'leak / piracy / play-early wording'],
  [/glitch|exploit|money (glitch|hack)|dupe|mod menu|\bmods?\b|hack|cheat|unlimited money/i, 'glitch, exploit, mod or cheat'],
  [/nude|naked|nsfw|\bsex|strip ?club|stripper|onlyfans|18\+|porn|boob|thirst/i, 'possible sexual content'],
  [/ending|final mission|dies\b|death of|killed off|betray|twist|plot|spoiler|cutscene|chapter \d|story mission|mission\s*#?\d|\bmission:/i, 'possible story spoiler'],
  [/n[i1]gg|f[a@]gg|retard|tranny|k[i1]ke|ch[i1]nk|sp[i1]c\b/i, 'slur in title'],
  [/racis|nazi|terror|suicid|school shoot|mass shoot|real(-| )life (crime|shooting)/i, 'sensitive real-world topic'],
  [/rockstar (confirms|announces)|official(ly)? (announced|confirmed)|insider|rumou?r|reportedly/i, 'could read as official news or rumor'],
  [/https?:\/\/|www\.|@\w{3,}/i, 'link or @mention in source title'],
];

export function riskReasons({ title = '', hook = '', caption = '', foundBySearch = false, category = '' }) {
  const text = `${title} \n ${hook} \n ${caption}`;
  const reasons = RULES.filter(([re]) => re.test(text)).map(([, why]) => why);
  if (foundBySearch) reasons.push('found by YouTube search: original creator not verified');
  if (category === 'guide') reasons.push('mission guide: may show story content');
  return [...new Set(reasons)];
}
