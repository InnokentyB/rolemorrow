// Operator-reviewed official entry pages. Seeds alone make no current-hiring claim.
export const ORGANIZATION_SEEDS=[
 {name:'Maze',homepage:'https://maze.co',careers:'https://maze.co/careers/',industry:'User research software'},
 {name:'Buffer',homepage:'https://buffer.com',careers:'https://buffer.com/journey',industry:'Social media software'},
 {name:'Linear',homepage:'https://linear.app',careers:'https://linear.app/careers',industry:'Product development software'},
 {name:'Vercel',homepage:'https://vercel.com',careers:'https://vercel.com/careers',industry:'Developer infrastructure'},
 {name:'Supabase',homepage:'https://supabase.com',careers:'https://supabase.com/careers',industry:'Database infrastructure'},
 {name:'PostHog',homepage:'https://posthog.com',careers:'https://posthog.com/careers',industry:'Product analytics'},
 {name:'Figma',homepage:'https://www.figma.com',careers:'https://www.figma.com/careers/',industry:'Design software'},
 {name:'Notion',homepage:'https://www.notion.com',careers:'https://www.notion.com/careers',industry:'Workspace software'},
 {name:'Stripe',homepage:'https://stripe.com',careers:'https://stripe.com/careers',industry:'Financial infrastructure'},
 {name:'Cloudflare',homepage:'https://www.cloudflare.com',careers:'https://www.cloudflare.com/careers/',industry:'Connectivity infrastructure'}
];

// Additional international product/technology employers; official entry URLs only.
ORGANIZATION_SEEDS.push(...[
 ['GitHub','https://github.com','https://github.com/about/careers','Developer platform'],
 ['GitLab','https://gitlab.com','https://about.gitlab.com/jobs/','Developer platform'],
 ['Atlassian','https://www.atlassian.com','https://www.atlassian.com/company/careers','Collaboration software'],
 ['Salesforce','https://www.salesforce.com','https://www.salesforce.com/company/careers/','Business software'],
 ['Fin (Intercom)','https://fin.ai','https://fin.ai/careers','Customer support software'],
 ['Miro','https://miro.com','https://miro.com/careers/','Collaboration software'],
 ['Mural','https://www.mural.co','https://www.mural.co/careers','Collaboration software'],
 ['Airtable','https://airtable.com','https://airtable.com/careers','Business software'],
 ['Zapier','https://zapier.com','https://zapier.com/jobs','Automation software'],
 ['Automattic','https://automattic.com','https://automattic.com/work-with-us/','Publishing software'],
 ['Dropbox','https://www.dropbox.com','https://jobs.dropbox.com/','Collaboration software'],
 ['Shopify','https://www.shopify.com','https://www.shopify.com/careers','Commerce software'],
 ['Canva','https://www.canva.com','https://www.canva.com/careers/','Design software'],
 ['HubSpot','https://www.hubspot.com','https://www.hubspot.com/careers','Business software'],
 ['Datadog','https://www.datadoghq.com','https://careers.datadoghq.com/','Observability software'],
 ['MongoDB','https://www.mongodb.com','https://www.mongodb.com/company/careers','Database infrastructure'],
 ['Elastic','https://www.elastic.co','https://www.elastic.co/careers','Search and observability'],
 ['Docker','https://www.docker.com','https://www.docker.com/careers/','Developer infrastructure'],
 ['Grafana Labs','https://grafana.com','https://grafana.com/about/careers/','Observability software'],
 ['HashiCorp','https://www.hashicorp.com','https://www.hashicorp.com/en/career','Infrastructure software'],
 ['DigitalOcean','https://www.digitalocean.com','https://www.digitalocean.com/careers','Cloud infrastructure'],
 ['Canonical','https://canonical.com','https://canonical.com/careers','Open source infrastructure'],
 ['JetBrains','https://www.jetbrains.com','https://www.jetbrains.com/careers/','Developer tools'],
 ['Reddit','https://redditinc.com','https://redditinc.com/careers','Community platform'],
 ['Discord','https://discord.com','https://discord.com/careers','Communication platform'],
 ['Zoom','https://zoom.us','https://careers.zoom.us/','Communication software'],
 ['Twilio','https://www.twilio.com','https://www.twilio.com/en-us/company/jobs','Communication infrastructure'],
 ['OpenAI','https://openai.com','https://openai.com/careers/','AI technology'],
 ['Anthropic','https://www.anthropic.com','https://www.anthropic.com/careers','AI technology'],
 ['DeepL','https://www.deepl.com','https://www.deepl.com/en/careers','Language technology']
].map(([name,homepage,careers,industry])=>({name,homepage,careers,industry})));

// Technology selection expanded on 2026-10-20. Entry pages do not imply active vacancies.
ORGANIZATION_SEEDS.push(...[
 {
  "name": "Microsoft",
  "homepage": "https://microsoft.com",
  "careers": "https://careers.microsoft.com",
  "industry": "Cloud infrastructure"
 },
 {
  "name": "Google",
  "homepage": "https://google.com",
  "careers": "https://www.google.com/about/careers/",
  "industry": "Cloud infrastructure"
 },
 {
  "name": "Amazon",
  "homepage": "https://amazon.com",
  "careers": "https://www.amazon.com/jobs",
  "industry": "Commerce software"
 },
 {
  "name": "Apple",
  "homepage": "https://apple.com",
  "careers": "https://www.apple.com/careers/",
  "industry": "Consumer technology"
 },
 {
  "name": "Meta",
  "homepage": "https://meta.com",
  "careers": "https://www.meta.com/careers/",
  "industry": "Community platform"
 },
 {
  "name": "Netflix",
  "homepage": "https://netflix.com",
  "careers": "https://jobs.netflix.com/",
  "industry": "Media technology"
 },
 {
  "name": "Spotify",
  "homepage": "https://spotify.com",
  "careers": "https://www.spotify.com/jobs/",
  "industry": "Media technology"
 },
 {
  "name": "Adobe",
  "homepage": "https://adobe.com",
  "careers": "https://careers.adobe.com/",
  "industry": "Design software"
 },
 {
  "name": "NVIDIA",
  "homepage": "https://nvidia.com",
  "careers": "https://www.nvidia.com/en-us/about-nvidia/careers/",
  "industry": "AI technology"
 },
 {
  "name": "AMD",
  "homepage": "https://amd.com",
  "careers": "https://careers.amd.com/",
  "industry": "Semiconductors"
 },
 {
  "name": "Intel",
  "homepage": "https://intel.com",
  "careers": "https://www.intel.com/content/www/us/en/jobs/jobs-at-intel.html",
  "industry": "Semiconductors"
 },
 {
  "name": "Arm",
  "homepage": "https://arm.com",
  "careers": "https://careers.arm.com/",
  "industry": "Semiconductors"
 },
 {
  "name": "Qualcomm",
  "homepage": "https://qualcomm.com",
  "careers": "https://www.qualcomm.com/company/careers",
  "industry": "Semiconductors"
 },
 {
  "name": "Cisco",
  "homepage": "https://cisco.com",
  "careers": "https://www.cisco.com/c/en/us/about/careers.html",
  "industry": "Connectivity infrastructure"
 },
 {
  "name": "Oracle",
  "homepage": "https://oracle.com",
  "careers": "https://www.oracle.com/careers/",
  "industry": "Database infrastructure"
 },
 {
  "name": "SAP",
  "homepage": "https://sap.com",
  "careers": "https://www.sap.com/about/careers.html",
  "industry": "Business software"
 },
 {
  "name": "ServiceNow",
  "homepage": "https://servicenow.com",
  "careers": "https://www.servicenow.com/careers.html",
  "industry": "Business software"
 },
 {
  "name": "Workday",
  "homepage": "https://workday.com",
  "careers": "https://www.workday.com/en-us/company/careers.html",
  "industry": "Business software"
 },
 {
  "name": "Snowflake",
  "homepage": "https://snowflake.com",
  "careers": "https://careers.snowflake.com/",
  "industry": "Database infrastructure"
 },
 {
  "name": "Databricks",
  "homepage": "https://databricks.com",
  "careers": "https://www.databricks.com/company/careers",
  "industry": "Database infrastructure"
 },
 {
  "name": "Confluent",
  "homepage": "https://confluent.io",
  "careers": "https://www.confluent.io/careers/",
  "industry": "Database infrastructure"
 },
 {
  "name": "ClickHouse",
  "homepage": "https://clickhouse.com",
  "careers": "https://clickhouse.com/company/careers",
  "industry": "Database infrastructure"
 },
 {
  "name": "Redis",
  "homepage": "https://redis.io",
  "careers": "https://redis.io/careers/",
  "industry": "Database infrastructure"
 },
 {
  "name": "Cockroach Labs",
  "homepage": "https://cockroachlabs.com",
  "careers": "https://www.cockroachlabs.com/careers/",
  "industry": "Database infrastructure"
 },
 {
  "name": "PlanetScale",
  "homepage": "https://planetscale.com",
  "careers": "https://planetscale.com/careers",
  "industry": "Database infrastructure"
 },
 {
  "name": "Neon",
  "homepage": "https://neon.com",
  "careers": "https://neon.com/careers",
  "industry": "Database infrastructure"
 },
 {
  "name": "Render",
  "homepage": "https://render.com",
  "careers": "https://render.com/careers",
  "industry": "Cloud infrastructure"
 },
 {
  "name": "Railway",
  "homepage": "https://railway.com",
  "careers": "https://railway.com/careers",
  "industry": "Cloud infrastructure"
 },
 {
  "name": "Fly.io",
  "homepage": "https://fly.io",
  "careers": "https://fly.io/jobs/",
  "industry": "Cloud infrastructure"
 },
 {
  "name": "Netlify",
  "homepage": "https://netlify.com",
  "careers": "https://www.netlify.com/careers/",
  "industry": "Developer infrastructure"
 },
 {
  "name": "Sentry",
  "homepage": "https://sentry.io",
  "careers": "https://sentry.io/careers/",
  "industry": "Observability software"
 },
 {
  "name": "New Relic",
  "homepage": "https://newrelic.com",
  "careers": "https://newrelic.com/about/careers",
  "industry": "Observability software"
 },
 {
  "name": "Honeycomb",
  "homepage": "https://honeycomb.io",
  "careers": "https://www.honeycomb.io/careers",
  "industry": "Observability software"
 },
 {
  "name": "LaunchDarkly",
  "homepage": "https://launchdarkly.com",
  "careers": "https://launchdarkly.com/careers/",
  "industry": "Developer tools"
 },
 {
  "name": "Snyk",
  "homepage": "https://snyk.io",
  "careers": "https://snyk.io/careers/",
  "industry": "Security software"
 },
 {
  "name": "Wiz",
  "homepage": "https://wiz.io",
  "careers": "https://www.wiz.io/careers",
  "industry": "Security software"
 },
 {
  "name": "CrowdStrike",
  "homepage": "https://crowdstrike.com",
  "careers": "https://www.crowdstrike.com/en-us/careers/",
  "industry": "Security software"
 },
 {
  "name": "Palo Alto Networks",
  "homepage": "https://paloaltonetworks.com",
  "careers": "https://jobs.paloaltonetworks.com/",
  "industry": "Security software"
 },
 {
  "name": "Okta",
  "homepage": "https://okta.com",
  "careers": "https://www.okta.com/company/careers/",
  "industry": "Security software"
 },
 {
  "name": "1Password",
  "homepage": "https://1password.com",
  "careers": "https://1password.com/careers",
  "industry": "Security software"
 },
 {
  "name": "Dashlane",
  "homepage": "https://dashlane.com",
  "careers": "https://www.dashlane.com/about/careers",
  "industry": "Security software"
 },
 {
  "name": "Proton",
  "homepage": "https://proton.me",
  "careers": "https://proton.me/careers",
  "industry": "Security software"
 },
 {
  "name": "Nord Security",
  "homepage": "https://nordsecurity.com",
  "careers": "https://nordsecurity.com/careers",
  "industry": "Security software"
 },
 {
  "name": "SentinelOne",
  "homepage": "https://sentinelone.com",
  "careers": "https://www.sentinelone.com/careers/",
  "industry": "Security software"
 },
 {
  "name": "Hugging Face",
  "homepage": "https://huggingface.co",
  "careers": "https://huggingface.co/join-us",
  "industry": "AI technology"
 },
 {
  "name": "Cohere",
  "homepage": "https://cohere.com",
  "careers": "https://cohere.com/careers",
  "industry": "AI technology"
 },
 {
  "name": "Mistral AI",
  "homepage": "https://mistral.ai",
  "careers": "https://mistral.ai/careers",
  "industry": "AI technology"
 },
 {
  "name": "Perplexity",
  "homepage": "https://perplexity.ai",
  "careers": "https://www.perplexity.ai/careers",
  "industry": "AI technology"
 },
 {
  "name": "ElevenLabs",
  "homepage": "https://elevenlabs.io",
  "careers": "https://elevenlabs.io/careers",
  "industry": "AI technology"
 },
 {
  "name": "Synthesia",
  "homepage": "https://synthesia.io",
  "careers": "https://www.synthesia.io/careers",
  "industry": "AI technology"
 },
 {
  "name": "Runway",
  "homepage": "https://runwayml.com",
  "careers": "https://runwayml.com/careers",
  "industry": "AI technology"
 },
 {
  "name": "Replicate",
  "homepage": "https://replicate.com",
  "careers": "https://replicate.com/about",
  "industry": "AI technology"
 },
 {
  "name": "Together AI",
  "homepage": "https://together.ai",
  "careers": "https://www.together.ai/careers",
  "industry": "AI technology"
 },
 {
  "name": "Weights & Biases",
  "homepage": "https://wandb.ai",
  "careers": "https://wandb.ai/site/careers/",
  "industry": "AI technology"
 },
 {
  "name": "LangChain",
  "homepage": "https://langchain.com",
  "careers": "https://www.langchain.com/careers",
  "industry": "AI technology"
 },
 {
  "name": "Replit",
  "homepage": "https://replit.com",
  "careers": "https://replit.com/careers",
  "industry": "Developer tools"
 },
 {
  "name": "Cursor",
  "homepage": "https://cursor.com",
  "careers": "https://cursor.com/careers",
  "industry": "Developer tools"
 },
 {
  "name": "Postman",
  "homepage": "https://postman.com",
  "careers": "https://www.postman.com/company/careers/",
  "industry": "Developer tools"
 },
 {
  "name": "Retool",
  "homepage": "https://retool.com",
  "careers": "https://retool.com/careers",
  "industry": "Developer tools"
 },
 {
  "name": "Webflow",
  "homepage": "https://webflow.com",
  "careers": "https://webflow.com/careers",
  "industry": "Design software"
 },
 {
  "name": "Framer",
  "homepage": "https://framer.com",
  "careers": "https://www.framer.com/careers/",
  "industry": "Design software"
 },
 {
  "name": "Typeform",
  "homepage": "https://typeform.com",
  "careers": "https://www.typeform.com/careers/",
  "industry": "Business software"
 },
 {
  "name": "Contentful",
  "homepage": "https://contentful.com",
  "careers": "https://www.contentful.com/careers/",
  "industry": "Publishing software"
 },
 {
  "name": "Sanity",
  "homepage": "https://sanity.io",
  "careers": "https://www.sanity.io/careers",
  "industry": "Publishing software"
 },
 {
  "name": "Storyblok",
  "homepage": "https://storyblok.com",
  "careers": "https://www.storyblok.com/jobs",
  "industry": "Publishing software"
 },
 {
  "name": "Algolia",
  "homepage": "https://algolia.com",
  "careers": "https://www.algolia.com/careers/",
  "industry": "Search and observability"
 },
 {
  "name": "Amplitude",
  "homepage": "https://amplitude.com",
  "careers": "https://amplitude.com/careers",
  "industry": "Product analytics"
 },
 {
  "name": "Mixpanel",
  "homepage": "https://mixpanel.com",
  "careers": "https://mixpanel.com/careers/",
  "industry": "Product analytics"
 },
 {
  "name": "Heap",
  "homepage": "https://heap.io",
  "careers": "https://www.heap.io/careers",
  "industry": "Product analytics"
 },
 {
  "name": "Fullstory",
  "homepage": "https://fullstory.com",
  "careers": "https://www.fullstory.com/careers/",
  "industry": "Product analytics"
 },
 {
  "name": "Hotjar",
  "homepage": "https://hotjar.com",
  "careers": "https://careers.hotjar.com/",
  "industry": "Product analytics"
 },
 {
  "name": "Pendo",
  "homepage": "https://pendo.io",
  "careers": "https://www.pendo.io/careers/",
  "industry": "Product analytics"
 },
 {
  "name": "Wise",
  "homepage": "https://wise.com",
  "careers": "https://wise.com/careers/",
  "industry": "Financial infrastructure"
 },
 {
  "name": "Adyen",
  "homepage": "https://adyen.com",
  "careers": "https://careers.adyen.com/",
  "industry": "Financial infrastructure"
 },
 {
  "name": "Plaid",
  "homepage": "https://plaid.com",
  "careers": "https://plaid.com/careers/",
  "industry": "Financial infrastructure"
 },
 {
  "name": "Revolut",
  "homepage": "https://revolut.com",
  "careers": "https://www.revolut.com/careers/",
  "industry": "Financial infrastructure"
 },
 {
  "name": "Klarna",
  "homepage": "https://klarna.com",
  "careers": "https://www.klarna.com/careers/",
  "industry": "Financial infrastructure"
 },
 {
  "name": "Brex",
  "homepage": "https://brex.com",
  "careers": "https://www.brex.com/careers",
  "industry": "Financial infrastructure"
 },
 {
  "name": "Ramp",
  "homepage": "https://ramp.com",
  "careers": "https://ramp.com/careers",
  "industry": "Financial infrastructure"
 },
 {
  "name": "Deel",
  "homepage": "https://deel.com",
  "careers": "https://www.deel.com/careers/",
  "industry": "Business software"
 }
]);

// Five inaccessible/unconfirmed new entry points are held back until source review.
for(let i=ORGANIZATION_SEEDS.length-1;i>=40;i--)if(['Amazon','Confluent','Wise','Hotjar','Ramp'].includes(ORGANIZATION_SEEDS[i].name))ORGANIZATION_SEEDS.splice(i,1);
const runway=ORGANIZATION_SEEDS.find(x=>x.name==='Runway');runway.homepage='https://runway.com';runway.careers='https://runway.com/careers';

// Exact publicly reported counts, not estimates or lower-bound marketing claims.
const employeeEvidence={
 'buffer.com':{count:73,asOf:'2026-10-20',source:'https://buffer.com/about'},
 'gitlab.com':{count:2580,asOf:'2026-01-31',source:'https://www.sec.gov/Archives/edgar/data/1653482/000165348226000087/a2026gitlabars.pdf'},
 'mongodb.com':{count:5636,asOf:'2026-01-31',source:'https://investors.mongodb.com/2026-annual-report-and-proxy-statement'}
};
for(const seed of ORGANIZATION_SEEDS){const evidence=employeeEvidence[new URL(seed.homepage).hostname.replace(/^www\./,'')];if(evidence)seed.employees={...evidence,reviewedAt:'2026-10-20'};}
