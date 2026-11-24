// Rule-based safety check (no AI). A draft with no reasons is auto-approved and published at its slot;
// anything flagged goes to Telegram for the owner's ✅/❌.
// Owner rule (2026-11-20, reaffirmed 2026-11-24): auto-approve everything; only possible platform-rule violations go to Telegram.

const RULES = [
  [/\bleak(ed|s)?\b|early access|play (it )?early|pirat|crack(ed)?|free download|torrent/i, 'leak / piracy / play-early wording'],
  [/glitch|exploit|money (glitch|hack)|dupe|mod menu|\bmods?\b|hack|cheat|unlimited money/i, 'glitch, exploit, mod or cheat'],
  [/nude|naked|nsfw|\bsex|strip ?club|stripper|onlyfans|18\+|porn|boob|thirst/i, 'possible sexual content'],
  [/n[i1]gg|f[a@]gg|retard|tranny|k[i1]ke|ch[i1]nk|sp[i1]c\b/i, 'slur in title'],
  [/racis|nazi|terror|suicid|school shoot|mass shoot|real(-| )life (crime|shooting)/i, 'sensitive real-world topic'],
  [/rockstar (confirms|announces)|official(ly)? (announced|confirmed)|insider|rumou?r|reportedly/i, 'could read as official news or rumor'],
];

export function riskReasons({ title = '', hook = '', caption = '', foundBySearch = false, category = '' }) {
  const text = `${title} \n ${hook} \n ${caption}`;
  const reasons = RULES.filter(([re]) => re.test(text)).map(([, why]) => why);
  return [...new Set(reasons)];
}
