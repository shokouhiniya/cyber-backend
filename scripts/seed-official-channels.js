/**
 * seed-official-channels.js
 *
 * Reads the official pages CSV and updates official_channels on each profile.
 * Matches profiles by promtic_identifier.external_id (slug).
 *
 * Usage: node scripts/seed-official-channels.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');

const db = new Client({
  host: process.env.DB_HOST, port: +process.env.DB_PORT || 5432,
  database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
});

// ── Data from CSV ─────────────────────────────────────────────────────────────
// Format: [slug, { twitter, telegram, instagram }]
// 'ندارد' = doesn't have it → omit

const CHANNELS = [
  ['khamenei',          { twitter: 'Rahbarenghelab_',    telegram: 'rahbar_enghelab_ir',    instagram: 'rahbar_enghelab_ir' }],
  ['pezeshkian',        { twitter: 'Masoudpazesh',       telegram: 'drpezeshkian_ir',       instagram: 'drmasoudpezeshkian' }],
  ['ghalibaf',          { twitter: 'mb_ghalibaf',        telegram: 'ghalibaf',              instagram: 'ghalibaf.ir' }],
  ['ejei',              { twitter: 'ejei_org',                                               instagram: 'ejjei_ir' }],
  ['sadegh_larijani',   { twitter: 'AmoliLarijaniir' }],
  ['aref',              { twitter: 'ir_aref',                                                instagram: 'aref_ir' }],
  ['jahangiri',         { twitter: 'Eshaq_jahangiri',    telegram: 'eshaghjahaangiri',      instagram: 'eshaqjahangiri' }],
  ['haddad_adel',       { twitter: 'HaddadAdel_ir' }],
  ['rouhani',           { twitter: 'Rouhani_ir',                                             instagram: 'hrouhani' }],
  ['ahmadinejad',       { twitter: 'Ahmadinejad_fa',     telegram: 'ahmadinejadmedia',      instagram: 'dr.ahmadinejad' }],
  ['khatami',           { twitter: 'Khatamimedia',       telegram: 'khatamimedia',          instagram: 'khatamimedia' }],
  ['rezaei',            { twitter: 'ir_rezaee',          telegram: 'rezaee_ir' }],
  ['vahidi',            { twitter: 'AH_Vahidi' }],
  ['hatami_army',       { twitter: 'hatami_org',                                             instagram: 'hatami_org' }],
  ['qaani',             { twitter: 'EsQaani' }],
  ['eslami_atomic',     {                                                                     instagram: 'mohammadeslami_official' }],
  ['hemmati',           { twitter: 'Hemmati_ir',         telegram: 'ahemmati',              instagram: 'abdolnaser_hemmati' }],
  ['zarif',             { twitter: 'JZarif',                                                 instagram: 'jzarif_ir' }],
  ['mohajerani',        { twitter: 'F_Mohajerani' }],
  ['jabali',            { twitter: 'Jebelli_ir',                                             instagram: 'jebeli.irib' }],
  ['hashemi_ict',       { twitter: 'HashemiSattar',                                          instagram: 'sattar__hashemi' }],
  ['araghchi',          { twitter: 'araghchi',           telegram: 's_a_araghchi',          instagram: 'araghchi' }],
  ['madanizadeh',       { twitter: 'SMadanizadeh',       telegram: 'seyedalimadanizadeh',   instagram: 'dr.madanizadeh' }],
  ['hazrati',           { twitter: 'elyashazrati' }],
  ['hajibabai',         { twitter: 'hajibabaei_ir',                                          instagram: 'hajibabaee_ir' }],
  ['dabir',             { twitter: 'alireza___dabir',                                        instagram: 'alirezadabir' }],
  ['sabbagian',         { twitter: 'mr_sabbaghian',      telegram: 'mr_sabbaghian',         instagram: 'mr_sabbaghian' }],
  ['zarghami',          { twitter: 'Zarghami_ez',        telegram: 'Zarghami_ez',           instagram: 'zarghami.ez' }],
  ['ghalenoi',          {                                                                     instagram: 'amirghalenoei' }],
  ['sabeti',            {                                 telegram: 'sabety_ir',             instagram: 'sabety_ir' }],
  ['zakani',            {                                 telegram: 'arzakani',              instagram: 'zakanialireza' }],
  ['tajzadeh',          { twitter: 'mostafatajzade',     telegram: 'MostafaTajzadeh',       instagram: 'seyed.mostafa.tajzade' }],
  ['bahonar',           {                                                                     instagram: 'bahonar_ir' }],
  ['nikzad',            { twitter: 'DrAliNikzad',        telegram: 'alinikzad_ir',          instagram: 'nikzad_ir' }],
  ['karroubi',          { twitter: 'mkaroubi',                                               instagram: 'mehdikaroubi' }],
  ['rasouli',           {                                 telegram: 'mahdirasuli_ir',        instagram: 'mahdirasuli_ir' }],
  ['ashna',             { twitter: 'hesamodin1',         telegram: 'hesmashena' }],
  ['ghasemian',         { twitter: 'IrQasemian',         telegram: 'qasemian_ir',           instagram: 'qasemian_ir' }],
  ['zeidabadi',         { twitter: 'Zeidabadi_ahmad',    telegram: 'ahmadzeidabad',         instagram: 'ahmadzeidabadiii' }],
  ['zibakalam',         { twitter: 'sadeghZibakalam',    telegram: 'sadeghzibakalam',       instagram: 'zibakalamsadegh' }],
  ['ahmad_khatami',     { twitter: 'Ahmadkhatami_ir' }],
];

function buildChannels(data) {
  const channels = [];
  if (data.twitter)   channels.push({ platform: 'x',         handle: data.twitter,   active: true, verified: false });
  if (data.telegram)  channels.push({ platform: 'telegram',  handle: data.telegram,  active: true, verified: false });
  if (data.instagram) channels.push({ platform: 'instagram', handle: data.instagram, active: true, verified: false });
  return channels;
}

async function main() {
  await db.connect();
  console.log('Connected.\n');

  let updated = 0, notFound = 0;

  for (const [slug, data] of CHANNELS) {
    const channels = buildChannels(data);
    if (channels.length === 0) continue;

    const res = await db.query(
      `UPDATE profiles
       SET official_channels = $1::jsonb
       WHERE promtic_identifier->>'external_id' = $2
       RETURNING name`,
      [JSON.stringify(channels), slug]
    );

    if (res.rowCount === 0) {
      console.log(`NOT FOUND: ${slug}`);
      notFound++;
    } else {
      console.log(`OK  ${res.rows[0].name} — ${channels.map(c => c.platform + ':' + c.handle).join(', ')}`);
      updated++;
    }
  }

  console.log(`\nDone. Updated: ${updated} | Not found: ${notFound}`);
  await db.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
