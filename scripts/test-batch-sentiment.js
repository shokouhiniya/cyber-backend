/**
 * Isolated test: call batch_sentiment with 5 posts and inspect the raw response.
 * Usage: node scripts/test-batch-sentiment.js
 */

const PROMTIC_BASE_URL = 'https://papi.cyber.pish.run';
const PROMTIC_API_KEY = 'pk_ef39b96c1e37d9fb3488680c84dba67d7a9f9f210af8f5d36971e8a60c5203cc';

const SAMPLE_POSTS = `[1] این دولت هیچ کاری برای مردم نکرده و فقط وعده می‌دهد

[2] پزشکیان بهترین انتخاب بود، حداقل آدم عاقلی است

[3] قیمت دلار دوباره بالا رفت، مردم دارند له می‌شوند زیر بار تورم

[4] جلسه مجلس امروز درباره بودجه خیلی جنجالی بود

[5] امیدوارم وضع بهتر بشه ولی فکر نمی‌کنم این دولت بتونه کاری کنه`;

const PROFILE_CONTEXT = `## Profile Context: Masoud Pezeshkian
Name: Masoud Pezeshkian
Persian Name: مسعود پزشکیان
Role/Position: President of Iran
Main Domain: government and executive politics`;

async function main() {
  console.log('Calling batch_sentiment with 5 test posts...\n');

  const body = {
    prompt_name: 'batch_sentiment',
    input_vars: {
      profile_context: PROFILE_CONTEXT,
      global_macro_political_context: 'Test context - no real events',
      global_macro_political_context_7d: '',
      posts_batch: SAMPLE_POSTS,
    },
    identifier: { external_id: 'pezeshkian', name: 'Pezeshkian', type: 'political_figure' },
    params: { temperature: 0.2, max_tokens: 8192 },
  };

  const res = await fetch(`${PROMTIC_BASE_URL}/invocations/execute`, {
    method: 'POST',
    headers: { 'x-api-key': PROMTIC_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  console.log('Status:', res.status);
  console.log('Response status:', json.data?.status);

  if (json.data?.status === 'completed') {
    console.log('\n=== RAW RESULT ===');
    console.log(json.data.result);
    console.log('\n=== PARSED ===');
    try {
      const clean = json.data.result.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(clean);
      console.log(JSON.stringify(parsed, null, 2));
      console.log('\n=== FIELD CHECK ===');
      for (const item of parsed) {
        console.log(`Post ${item.id}: sentiment=${item.sentiment}, spectrum=${item.political_spectrum}, relevance=${item.relevance_score}, bot=${item.bot_probability}, outlook=${item.outlook}`);
      }
    } catch (e) {
      console.log('Parse error:', e.message);
    }
  } else if (json.data?.status === 'pending' || json.data?.status === 'processing') {
    console.log('Polling for result...');
    const uid = json.data.uid;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`${PROMTIC_BASE_URL}/invocations/${uid}`, {
        headers: { 'x-api-key': PROMTIC_API_KEY },
      });
      const pollJson = await pollRes.json();
      const data = pollJson.data || pollJson;
      if (data.status === 'completed') {
        console.log('\n=== RAW RESULT ===');
        console.log(data.result);
        console.log('\n=== PARSED ===');
        try {
          const clean = data.result.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
          const parsed = JSON.parse(clean);
          console.log(JSON.stringify(parsed, null, 2));
          console.log('\n=== FIELD CHECK ===');
          for (const item of parsed) {
            console.log(`Post ${item.id}: sentiment=${item.sentiment}, spectrum=${item.political_spectrum}, relevance=${item.relevance_score}, bot=${item.bot_probability}, outlook=${item.outlook}`);
          }
        } catch (e) {
          console.log('Parse error:', e.message);
        }
        return;
      }
      if (data.status === 'error') {
        console.log('ERROR:', data.error_message);
        return;
      }
      process.stdout.write('.');
    }
    console.log('\nTimeout waiting for result');
  } else {
    console.log('Unexpected response:', JSON.stringify(json, null, 2));
  }
}

main().catch(console.error);
