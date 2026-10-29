// A board inventory measures that source only, never the employer's entire estate.
const greenhouseHosts=new Set(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io']);
export function canonicalListingUrl(value){
 const url=new URL(value);url.hash='';
 if(greenhouseHosts.has(url.hostname)||['jobs.ashbyhq.com','jobs.lever.co','jobs.eu.lever.co'].includes(url.hostname)){
  url.search='';url.pathname=url.pathname.replace(/\/$/,'');
 }
 return url.href;
}
export function listingIdentity(value){
 const url=new URL(canonicalListingUrl(value));
 if(greenhouseHosts.has(url.hostname))url.hostname='boards.greenhouse.io';
 return url.href;
}
export function measureDiscovery({inventory,candidateCount,inspected,returnedUrls,failures}){
 const known=new Set((inventory?.urls??[]).map(listingIdentity)),returned=new Set(returnedUrls.map(listingIdentity));
 const returnedKnownListings=[...known].filter(url=>returned.has(url)).length;
 const complete=inventory?.complete===true;
 return {scope:'linked-official-boards',status:complete?'known':'unknown',knownListings:complete?known.size:null,
  returnedKnownListings,missedKnownListings:complete?known.size-returnedKnownListings:null,
  recall:complete&&known.size?returnedKnownListings/known.size:null,
  candidateCount,inspected,returned:returned.size,truncated:inspected<candidateCount,failures};
}
export function coverageNote(m){
 const denominator=m.status==='known'?`${m.returnedKnownListings}/${m.knownListings} known listings from linked official boards returned${m.knownListings?` (${Math.round(m.recall*100)}%)`:''}.`:'Total listing count unknown; no completeness percentage available.';
 return `${denominator} ${m.inspected}/${m.candidateCount} candidate URLs inspected; ${m.failures} resources or postings unavailable or invalid.${m.truncated?' Candidate or job limit left listings uninspected.':''} Employer-wide coverage remains partial; other sources may contain vacancies.`;
}
