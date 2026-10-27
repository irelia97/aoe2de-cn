export const tournamentResultCategories = Object.freeze({
  s:{label:'S 级',page:'Age_of_Empires_II/S-Tier_Tournaments'},
  a:{label:'A 级',page:'Age_of_Empires_II/A-Tier_Tournaments'},
  b:{label:'B 级',page:'Age_of_Empires_II/B-Tier_Tournaments'},
  c:{label:'C 级',page:'Age_of_Empires_II/C-Tier_Tournaments'},
  show:{label:'表演赛',page:'Age_of_Empires_II/Show_Matches'},
  qualifier:{label:'资格赛',page:'Age_of_Empires_II/Qualifier_Tournaments'},
});

const decode = value => String(value || '')
  .replace(/<br\s*\/?\s*>/gi,' / ')
  .replace(/<[^>]*>/g,' ')
  .replace(/&nbsp;|&#160;/gi,' ')
  .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
  .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
  .replace(/&#x([0-9a-f]+);/gi,(_,hex)=>String.fromCodePoint(Number.parseInt(hex,16)))
  .replace(/&#(\d+);/g,(_,number)=>String.fromCodePoint(Number(number)))
  .replace(/\s+/g,' ').trim();

const wikiUrl = value => {
  try {
    const url = new URL(decode(value),'https://liquipedia.net');
    return url.hostname === 'liquipedia.net' && url.pathname.startsWith('/ageofempires/') ? url.href : '';
  } catch { return ''; }
};

const assetUrl = value => {
  try {
    const url = new URL(decode(value),'https://liquipedia.net');
    return url.hostname === 'liquipedia.net' && url.pathname.startsWith('/commons/images/') ? url.href : '';
  } catch { return ''; }
};

const teamLogos = Object.freeze({
  'Vietnam Legends':'https://liquipedia.net/commons/images/6/62/Vietnam_Legends_allmode.png',
  TyRanT:'https://liquipedia.net/commons/images/1/11/Team_TyRanT_allmode.png',
  SY:'https://liquipedia.net/commons/images/0/00/SY_logo_screenshot.png',
  'Team Vitality':'https://liquipedia.net/commons/images/e/e4/Team_Vitality_2023_lightmode.png',
  Heresy:'https://liquipedia.net/commons/images/f/f5/Heresy_allmode.png',
});

const withKnownLogo = entry => entry && !entry.flag && !entry.logo && teamLogos[entry.name]
  ? {...entry,logo:teamLogos[entry.name]}
  : entry;

const firstImage = html => {
  const image = String(html || '').match(/<img\b[^>]*src="([^"]+)"[^>]*>/i);
  return image ? assetUrl(image[1]) : '';
};

const flags = html => [...String(html || '').matchAll(/<span\b[^>]*class="[^"]*flag[^"]*"[^>]*>[\s\S]*?<img\b([^>]*)>/gi)].map(match=>{
  const attributes=match[1];
  return {
    country:decode(attributes.match(/(?:alt|title)="([^"]+)"/i)?.[1] || ''),
    image:assetUrl(attributes.match(/src="([^"]+)"/i)?.[1] || '')
  };
}).filter(flag=>flag.country || flag.image);

const placements = html => {
  const source=String(html || '');
  const players=[...source.matchAll(/<div\b[^>]*class="[^"]*block-player[^"]*"[^>]*>([\s\S]*?)(?=<\/div>\s*<\/div>|<div\b[^>]*class="[^"]*block-player|$)/gi)].map(match=>{
    const block=match[1];
    const name=decode(block.match(/<span\b[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || block);
    const [flag]=flags(block);
    return name ? {name,country:flag?.country || '',flag:flag?.image || '',logo:flag ? '' : firstImage(block)} : null;
  }).filter(Boolean);
  if (players.length) return players.map(withKnownLogo);
  const links=[...source.matchAll(/<a\b[^>]*href="\/ageofempires\/[^"]+"[^>]*>([\s\S]*?)<\/a>/gi)].map((match,index,list)=>{
    const name=decode(match[1]);
    if (!name) return null;
    const start=index ? (list[index-1].index + list[index-1][0].length) : 0;
    const prefix=source.slice(start,match.index);
    return {name,country:'',flag:'',logo:firstImage(prefix)};
  }).filter(Boolean);
  if (links.length) return links.map(withKnownLogo);
  const name=decode(source);
  const [flag]=flags(source);
  return name ? [withKnownLogo({name,country:flag?.country || '',flag:flag?.image || '',logo:flag ? '' : firstImage(source)})] : [];
};

export function parseTournamentResultsHtml(html) {
  const source = String(html || '');
  const results = [];
  const tablePattern = /<table\b[^>]*class="[^"]*table2(?:&#95;&#95;|__)table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  for (const table of source.matchAll(tablePattern)) {
    const precedingHeadings = [...source.slice(0,table.index).matchAll(/<h3\b[^>]*id="(\d{4})"[^>]*>/gi)];
    const year = precedingHeadings.at(-1)?.[1] || '';
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
      const nameIndex = cells.findIndex(cell=>/column(?:&#95;&#95;|__)tournament/i.test(cell[1]));
      const qualifier = /column(?:&#95;&#95;|__)qualified/i.test(cells[nameIndex+5]?.[1] || '');
      if (nameIndex < 0 || cells.length < nameIndex+(qualifier ? 6 : 7)) continue;
      const name = decode(cells[nameIndex][2]);
      if (!name) continue;
      const href = cells[nameIndex][2].match(/<a\b[^>]*href="([^"]+)"/i)?.[1] || '';
      results.push({
        year, tier:decode(cells[0]?.[2]), name, url:wikiUrl(href), logo:firstImage(cells[nameIndex-1]?.[2]),
        dates:decode(cells[nameIndex+1][2]), prize:decode(cells[nameIndex+2][2]),
        location:decode(cells[nameIndex+3][2]), locationFlags:flags(cells[nameIndex+3][2]), participants:decode(cells[nameIndex+4][2]),
        winner:qualifier ? '' : decode(cells[nameIndex+5][2]),
        runnerUp:qualifier ? '' : decode(cells[nameIndex+6][2]),
        qualified:qualifier ? decode(cells[nameIndex+5][2]) : '',
        winnerEntries:qualifier ? [] : placements(cells[nameIndex+5][2]),
        runnerUpEntries:qualifier ? [] : placements(cells[nameIndex+6][2]),
        qualifiedEntries:qualifier ? placements(cells[nameIndex+5][2]) : [],
        score:''
      });
    }
  }
  return results;
}
