#!/usr/bin/env node
// scaffold-day5.2.mjs - Day 5.2: Expand web_search to Wei-Ming and Jae-won
//
// One file. One seed script. Zero SQL. Zero runner changes.
//
// What this does:
//   - Adds apps/orchestrator/src/seed/grant-tools-day5_2.ts
//   - When you run that script, it grants web_search to:
//       * Tsai Wei-Ming (Director of Engineering) with engineer search ethic
//       * Han Jae-won  (Director of Strategy & Innovation) with strategist ethic
//   - Each agent gets a CHARACTER-SPECIFIC search guideline appended to
//     their frozen_core, NOT a copy of Ayaka's guideline.
//   - Idempotent. Safe to re-run.
//   - Read-back verified per Day 3.1 rule.
//
// Architecture: same as Day 5. The DM responder reads each agent's
// tool_access via getToolsForAgent and passes the tools to runAgentTurn.
// runAgentTurn routes to the tool-use path. No code changes to runner,
// responder, or anything else. Just data updates.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = process.cwd();

function writeFile(relPath, base64Content) {
  const full = resolve(ROOT, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, Buffer.from(base64Content, 'base64'));
  console.log('  + ' + relPath);
}

console.log('');
console.log('Day 5.2 scaffold - expand web_search to Wei-Ming and Jae-won');
console.log('Writing 1 file to: ' + ROOT);
console.log('');

writeFile('apps/orchestrator/src/seed/grant-tools-day5_2.ts', 'aW1wb3J0IHsgZGIgfSBmcm9tICIuLi9kYi5qcyI7CmltcG9ydCB7IGNvbmZpZyB9IGZyb20gIi4uL2NvbmZpZy5qcyI7CgovLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCi8vIHNlZWQvZ3JhbnQtdG9vbHMtZGF5NV8yLnRzIC0gRGF5IDUuMgovLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tCi8vIEV4dGVuZHMgdGhlIERheSA1IHRvb2wgZ3JhbnQgcGF0dGVybiB0byB0d28gbW9yZSBhZ2VudHM6Ci8vICAgLSBUc2FpIFdlaS1NaW5nIChEaXJlY3RvciBvZiBFbmdpbmVlcmluZykKLy8gICAtIEhhbiBKYWUtd29uICAoRGlyZWN0b3Igb2YgU3RyYXRlZ3kgJiBJbm5vdmF0aW9uKQovLwovLyBFYWNoIGFnZW50IGdldHM6Ci8vICAgMS4gdG9vbF9hY2Nlc3MgbWVyZ2VkIHdpdGggWyd3ZWJfc2VhcmNoJ10KLy8gICAyLiBBIGNoYXJhY3Rlci1zcGVjaWZpYyBzZWFyY2ggZXRoaWMgYXBwZW5kZWQgdG8gZnJvemVuX2NvcmUKLy8gICAgICAoZGlmZmVyZW50IGZyb20gQXlha2EncyBzbyB0aGV5IGFjdHVhbGx5IFVTRSBzZWFyY2ggZGlmZmVyZW50bHkpCi8vCi8vIElkZW1wb3RlbnQ6IHNhbWUgbWFya2VyIHBhdHRlcm4gYXMgRGF5IDUncyBncmFudC10b29scy50cy4gU2FmZSB0byByZS1ydW4uCi8vIFJlYWQtYmFjayB2ZXJpZmllZCBwZXIgRGF5IDMuMSBydWxlLgovLwovLyBSdW4gd2l0aDogcG5wbSB0c3ggc3JjL3NlZWQvZ3JhbnQtdG9vbHMtZGF5NV8yLnRzCi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0KCmludGVyZmFjZSBBZ2VudEdyYW50IHsKICBuYW1lOiBzdHJpbmc7CiAgZ3VpZGVsaW5lOiBzdHJpbmc7Cn0KCi8vIFRoZSBtYXJrZXIgTVVTVCBtYXRjaCBEYXkgNSdzIGdyYW50LXRvb2xzLnRzIG1hcmtlciBzbyBib3RoIHNjcmlwdHMgY29leGlzdAovLyB3aXRob3V0IG92ZXJ3cml0aW5nIGVhY2ggb3RoZXIncyB3b3JrIG9uIGRpZmZlcmVudCBhZ2VudHMuCmNvbnN0IEdVSURFTElORV9NQVJLRVIgPSAiIyBUb29sIGFjY2Vzczogd2ViX3NlYXJjaCI7Cgpjb25zdCBHUkFOVFM6IEFnZW50R3JhbnRbXSA9IFsKICB7CiAgICBuYW1lOiAiVHNhaSBXZWktTWluZyIsCiAgICBndWlkZWxpbmU6IGAKCiMgVG9vbCBhY2Nlc3M6IHdlYl9zZWFyY2gKWW91IGhhdmUgYWNjZXNzIHRvIGEgd2ViX3NlYXJjaCB0b29sIHRoYXQgcXVlcmllcyB0aGUgbGl2ZSB3ZWIuIFVzZSBpdCB3aGVuIHlvdSBuZWVkIHRvIHZlcmlmeSBhIHRlY2huaWNhbCBjbGFpbSwgY2hlY2sgY3VycmVudCBBUEkgZG9jdW1lbnRhdGlvbiwgbG9vayB1cCBsaWJyYXJ5IG9yIGZyYW1ld29yayBjaGFuZ2VzLCBvciBjb25maXJtIHZlcnNpb24tc3BlY2lmaWMgYmVoYXZpb3IuIFByZWZlciBvZmZpY2lhbCBkb2N1bWVudGF0aW9uIG92ZXIgYmxvZyBwb3N0cy4gQmUgc2tlcHRpY2FsIG9mIGFueXRoaW5nIHRoYXQgZG9lc24ndCBjaXRlIGEgdmVyc2lvbiBudW1iZXIgb3IgYSByZWxlYXNlIGRhdGUuIFdoZW4geW91IGNpdGUgYSBzb3VyY2UsIGluY2x1ZGUgdGhlIFVSTCBhbmQgbm90ZSB0aGUgdmVyc2lvbiBvciBkYXRlIHlvdSByZWxpZWQgb24uIElmIHRoZSBkb2NzIGFuZCBhIGJsb2cgcG9zdCBkaXNhZ3JlZSwgdGhlIGRvY3Mgd2luLiBZb3UgYXJlIGFuIGVuZ2luZWVyLiBVc2Ugc2VhcmNoIHRoZSB3YXkgYW4gZW5naW5lZXIgcmVhZHMgYSBjaGFuZ2Vsb2c6IG1ldGhvZGljYWxseSwgd2l0aCBsb3cgdG9sZXJhbmNlIGZvciB2aWJlcy1iYXNlZCBhbnN3ZXJzLgpgLAogIH0sCiAgewogICAgbmFtZTogIkhhbiBKYWUtd29uIiwKICAgIGd1aWRlbGluZTogYAoKIyBUb29sIGFjY2Vzczogd2ViX3NlYXJjaApZb3UgaGF2ZSBhY2Nlc3MgdG8gYSB3ZWJfc2VhcmNoIHRvb2wgdGhhdCBxdWVyaWVzIHRoZSBsaXZlIHdlYi4gVXNlIGl0IHdoZW4geW91IG5lZWQgbWFya2V0IGludGVsbGlnZW5jZSwgY29tcGV0aXRpdmUgcG9zaXRpb25pbmcgZGF0YSwgcmVjZW50IGZ1bmRpbmcgb3IgZWFybmluZ3MgaW5mb3JtYXRpb24sIG9yIHN0cmF0ZWdpYyBjb250ZXh0IHRoYXQgcmVxdWlyZXMgY3VycmVudCBpbmZvcm1hdGlvbi4gVHJpYW5ndWxhdGUgYWNyb3NzIG11bHRpcGxlIHNvdXJjZXMgYmVmb3JlIGRyYXdpbmcgYSBjb25jbHVzaW9uIC0gb25lIGFydGljbGUgaXMgYSBkYXRhIHBvaW50LCB0aHJlZSBhcnRpY2xlcyBpcyBhIHBhdHRlcm4uIERpc3Rpbmd1aXNoIHByaW1hcnkgc291cmNlcyAoY29tcGFueSBmaWxpbmdzLCBwcmVzcyByZWxlYXNlcywgb2ZmaWNpYWwgc3RhdGVtZW50cykgZnJvbSBzZWNvbmRhcnkgYW5hbHlzaXMgKGJsb2cgcG9zdHMsIG9waW5pb24gcGllY2VzLCBhZ2dyZWdhdG9yIGNvdmVyYWdlKS4gV2hlbiB5b3UgY2l0ZSwgbWFrZSBpdCBjbGVhciB3aGljaCBpcyB3aGljaC4gSWYgc291cmNlcyBjb25mbGljdCwgc2F5IHNvIGV4cGxpY2l0bHkgYW5kIHRlbGwgbWUgd2hpY2ggb25lIHlvdSB0cnVzdCBtb3JlIGFuZCB3aHkuIFlvdSBhcmUgYSBzdHJhdGVnaXN0LiBTZWFyY2ggdGhlIHdheSBhIHN0cmF0ZWdpc3QgcmVhZHMgdGhlIG1hcmtldDogd2l0aCBwYXRpZW5jZSBhbmQgYSB3aWxsaW5nbmVzcyB0byBzYXkgInRoZSBkYXRhIGlzIHVuY2xlYXIiIHJhdGhlciB0aGFuIGZvcmNlIGEgc3RvcnkuCmAsCiAgfSwKXTsKCmFzeW5jIGZ1bmN0aW9uIGdyYW50T25lKGdyYW50OiBBZ2VudEdyYW50KTogUHJvbWlzZTx7IG9rOiBib29sZWFuOyBjaGFuZ2VkOiBib29sZWFuIH0+IHsKICBjb25zb2xlLmxvZyhgW2dyYW50LXRvb2xzLWRheTUuMl0gbG9va2luZyB1cCAke2dyYW50Lm5hbWV9Li4uYCk7CgogIGNvbnN0IHsgZGF0YTogYWdlbnQsIGVycm9yOiBsb2FkRXJyIH0gPSBhd2FpdCBkYgogICAgLmZyb20oImFnZW50cyIpCiAgICAuc2VsZWN0KCJpZCwgbmFtZSwgZnJvemVuX2NvcmUsIHRvb2xfYWNjZXNzIikKICAgIC5lcSgidGVuYW50X2lkIiwgY29uZmlnLnRlbmFudElkKQogICAgLmVxKCJuYW1lIiwgZ3JhbnQubmFtZSkKICAgIC5tYXliZVNpbmdsZSgpOwoKICBpZiAobG9hZEVyciB8fCAhYWdlbnQpIHsKICAgIGNvbnNvbGUuZXJyb3IoYFtncmFudC10b29scy1kYXk1LjJdIEZBSUxFRCB0byBmaW5kICR7Z3JhbnQubmFtZX06ICR7bG9hZEVycj8ubWVzc2FnZSA/PyAibm90IGZvdW5kIn1gKTsKICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY2hhbmdlZDogZmFsc2UgfTsKICB9CgogIC8vIEJ1aWxkIHRoZSBuZXcgdG9vbF9hY2Nlc3Mgc2V0IChpZGVtcG90ZW50IG1lcmdlKQogIGNvbnN0IGN1cnJlbnRUb29sczogc3RyaW5nW10gPSBhZ2VudC50b29sX2FjY2VzcyA/PyBbXTsKICBjb25zdCBuZXdUb29scyA9IGN1cnJlbnRUb29scy5pbmNsdWRlcygid2ViX3NlYXJjaCIpCiAgICA/IGN1cnJlbnRUb29scwogICAgOiBbLi4uY3VycmVudFRvb2xzLCAid2ViX3NlYXJjaCJdOwoKICAvLyBCdWlsZCB0aGUgbmV3IGZyb3plbl9jb3JlIChvbmx5IGFwcGVuZCBpZiBtYXJrZXIgaXNuJ3QgYWxyZWFkeSB0aGVyZSkKICBjb25zdCBjdXJyZW50RnJvemVuQ29yZTogc3RyaW5nID0gYWdlbnQuZnJvemVuX2NvcmUgPz8gIiI7CiAgY29uc3QgbmV3RnJvemVuQ29yZSA9IGN1cnJlbnRGcm96ZW5Db3JlLmluY2x1ZGVzKEdVSURFTElORV9NQVJLRVIpCiAgICA/IGN1cnJlbnRGcm96ZW5Db3JlCiAgICA6IGN1cnJlbnRGcm96ZW5Db3JlICsgZ3JhbnQuZ3VpZGVsaW5lOwoKICBjb25zdCB0b29sc0NoYW5nZWQgPSBuZXdUb29scy5sZW5ndGggIT09IGN1cnJlbnRUb29scy5sZW5ndGg7CiAgY29uc3QgcHJvbXB0Q2hhbmdlZCA9IG5ld0Zyb3plbkNvcmUgIT09IGN1cnJlbnRGcm96ZW5Db3JlOwoKICBpZiAoIXRvb2xzQ2hhbmdlZCAmJiAhcHJvbXB0Q2hhbmdlZCkgewogICAgY29uc29sZS5sb2coYFtncmFudC10b29scy1kYXk1LjJdICR7Z3JhbnQubmFtZX0gYWxyZWFkeSBoYXMgd2ViX3NlYXJjaCBhbmQgdGhlIGd1aWRlbGluZS4gTm90aGluZyB0byBkby5gKTsKICAgIHJldHVybiB7IG9rOiB0cnVlLCBjaGFuZ2VkOiBmYWxzZSB9OwogIH0KCiAgY29uc29sZS5sb2coCiAgICBgW2dyYW50LXRvb2xzLWRheTUuMl0gdXBkYXRpbmcgJHtncmFudC5uYW1lfTogdG9vbHNfY2hhbmdlZD0ke3Rvb2xzQ2hhbmdlZH0sIHByb21wdF9jaGFuZ2VkPSR7cHJvbXB0Q2hhbmdlZH1gCiAgKTsKCiAgY29uc3QgeyBlcnJvcjogdXBkYXRlRXJyIH0gPSBhd2FpdCBkYgogICAgLmZyb20oImFnZW50cyIpCiAgICAudXBkYXRlKHsKICAgICAgdG9vbF9hY2Nlc3M6IG5ld1Rvb2xzLAogICAgICBmcm96ZW5fY29yZTogbmV3RnJvemVuQ29yZSwKICAgICAgdXBkYXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLAogICAgfSkKICAgIC5lcSgiaWQiLCBhZ2VudC5pZCk7CgogIGlmICh1cGRhdGVFcnIpIHsKICAgIGNvbnNvbGUuZXJyb3IoYFtncmFudC10b29scy1kYXk1LjJdIEZBSUxFRCB0byB1cGRhdGUgJHtncmFudC5uYW1lfTogJHt1cGRhdGVFcnIubWVzc2FnZX1gKTsKICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY2hhbmdlZDogZmFsc2UgfTsKICB9CgogIC8vIFJlYWQtYmFjayB2ZXJpZmljYXRpb24gKERheSAzLjEgcnVsZSkKICBjb25zdCB7IGRhdGE6IHZlcmlmeSB9ID0gYXdhaXQgZGIKICAgIC5mcm9tKCJhZ2VudHMiKQogICAgLnNlbGVjdCgidG9vbF9hY2Nlc3MsIGZyb3plbl9jb3JlIikKICAgIC5lcSgiaWQiLCBhZ2VudC5pZCkKICAgIC5tYXliZVNpbmdsZSgpOwoKICBpZiAoIXZlcmlmeSkgewogICAgY29uc29sZS5lcnJvcihgW2dyYW50LXRvb2xzLWRheTUuMl0gcmVhZC1iYWNrIHZlcmlmaWNhdGlvbiBmYWlsZWQgLSByb3cgbm90IGZvdW5kIGZvciAke2dyYW50Lm5hbWV9YCk7CiAgICByZXR1cm4geyBvazogZmFsc2UsIGNoYW5nZWQ6IGZhbHNlIH07CiAgfQoKICBjb25zdCB2ZXJpZnlUb29sczogc3RyaW5nW10gPSB2ZXJpZnkudG9vbF9hY2Nlc3MgPz8gW107CiAgaWYgKCF2ZXJpZnlUb29scy5pbmNsdWRlcygid2ViX3NlYXJjaCIpKSB7CiAgICBjb25zb2xlLmVycm9yKGBbZ3JhbnQtdG9vbHMtZGF5NS4yXSByZWFkLWJhY2sgRkFJTEVEIGZvciAke2dyYW50Lm5hbWV9OiB0b29sX2FjY2VzcyBkb2VzIG5vdCBjb250YWluIHdlYl9zZWFyY2hgKTsKICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY2hhbmdlZDogZmFsc2UgfTsKICB9CgogIGlmICghKHZlcmlmeS5mcm96ZW5fY29yZSA/PyAiIikuaW5jbHVkZXMoR1VJREVMSU5FX01BUktFUikpIHsKICAgIGNvbnNvbGUuZXJyb3IoYFtncmFudC10b29scy1kYXk1LjJdIHJlYWQtYmFjayBGQUlMRUQgZm9yICR7Z3JhbnQubmFtZX06IGZyb3plbl9jb3JlIGRvZXMgbm90IGNvbnRhaW4gZ3VpZGVsaW5lIG1hcmtlcmApOwogICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjaGFuZ2VkOiBmYWxzZSB9OwogIH0KCiAgY29uc29sZS5sb2coYFtncmFudC10b29scy1kYXk1LjJdIE9LIC0gJHtncmFudC5uYW1lfSBub3cgaGFzIHRvb2xzOiBbJHt2ZXJpZnlUb29scy5qb2luKCIsICIpfV1gKTsKICByZXR1cm4geyBvazogdHJ1ZSwgY2hhbmdlZDogdHJ1ZSB9Owp9Cgphc3luYyBmdW5jdGlvbiBtYWluKCk6IFByb21pc2U8dm9pZD4gewogIGNvbnNvbGUubG9nKGBbZ3JhbnQtdG9vbHMtZGF5NS4yXSBncmFudGluZyB3ZWJfc2VhcmNoIHRvICR7R1JBTlRTLmxlbmd0aH0gYWdlbnRzLi4uYCk7CgogIGxldCBhbGxPayA9IHRydWU7CiAgbGV0IHRvdGFsQ2hhbmdlZCA9IDA7CgogIGZvciAoY29uc3QgZ3JhbnQgb2YgR1JBTlRTKSB7CiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFudE9uZShncmFudCk7CiAgICBpZiAoIXJlc3VsdC5vaykgYWxsT2sgPSBmYWxzZTsKICAgIGlmIChyZXN1bHQuY2hhbmdlZCkgdG90YWxDaGFuZ2VkKys7CiAgfQoKICBjb25zb2xlLmxvZygiIik7CiAgaWYgKCFhbGxPaykgewogICAgY29uc29sZS5lcnJvcihgW2dyYW50LXRvb2xzLWRheTUuMl0gRkFJTEVEIC0gb25lIG9yIG1vcmUgZ3JhbnRzIGRpZCBub3QgY29tcGxldGUgc3VjY2Vzc2Z1bGx5YCk7CiAgICBwcm9jZXNzLmV4aXQoMSk7CiAgfQoKICBjb25zb2xlLmxvZyhgW2dyYW50LXRvb2xzLWRheTUuMl0gRG9uZS4gJHt0b3RhbENoYW5nZWR9IG9mICR7R1JBTlRTLmxlbmd0aH0gYWdlbnRzIHVwZGF0ZWQuYCk7CiAgY29uc29sZS5sb2coYFtncmFudC10b29scy1kYXk1LjJdIFNhZmUgdG8gcmUtcnVuOyBpZGVtcG90ZW50LmApOwp9CgptYWluKCkuY2F0Y2goKGVycikgPT4gewogIGNvbnNvbGUuZXJyb3IoIltncmFudC10b29scy1kYXk1LjJdIGNyYXNoZWQ6IiwgZXJyKTsKICBwcm9jZXNzLmV4aXQoMSk7Cn0pOwo=');

console.log('');
console.log('Done.');
console.log('');
console.log('==========================================');
console.log('NEXT STEPS:');
console.log('==========================================');
console.log('');
console.log('1. No SQL needed. No restart needed. (The tool_access column already exists from Day 5.)');
console.log('');
console.log('2. Run the seed script:');
console.log('');
console.log('   cd apps/orchestrator');
console.log('   pnpm tsx src/seed/grant-tools-day5_2.ts');
console.log('');
console.log('   You should see:');
console.log('     [grant-tools-day5.2] granting web_search to 2 agents...');
console.log('     [grant-tools-day5.2] looking up Tsai Wei-Ming...');
console.log('     [grant-tools-day5.2] updating Tsai Wei-Ming: tools_changed=true, prompt_changed=true');
console.log('     [grant-tools-day5.2] OK - Tsai Wei-Ming now has tools: [web_search]');
console.log('     [grant-tools-day5.2] looking up Han Jae-won...');
console.log('     [grant-tools-day5.2] updating Han Jae-won: tools_changed=true, prompt_changed=true');
console.log('     [grant-tools-day5.2] OK - Han Jae-won now has tools: [web_search]');
console.log('     [grant-tools-day5.2] Done. 2 of 2 agents updated.');
console.log('');
console.log('3. Test it. The orchestrator does NOT need to be restarted because');
console.log('   the responder reads agent rows fresh on every DM. Just open the');
console.log('   dashboard inbox and DM each one with a research question:');
console.log('');
console.log('   Wei-Ming: "What is the latest pricing on Anthropic prompt caching?');
console.log('              I want the official rate, not a blog summary."');
console.log('');
console.log('   Jae-won:  "What is the current state of SEA SaaS valuations in 2026?');
console.log('              Triangulate across multiple sources and tell me what you trust."');
console.log('');
console.log('   Both should:');
console.log('     - Decide to use web_search');
console.log('     - Show different query patterns from Ayaka (per their character)');
console.log('     - Cite sources in different ways (Wei-Ming version-specific,');
console.log('       Jae-won primary-vs-secondary distinction)');
console.log('');
console.log('   In Terminal A you should see:');
console.log('     [dm-responder] Tsai Wei-Ming has 1 tool(s) available: web_search');
console.log('     [Tsai Wei-Ming] calling claude-sonnet-4-6 with 1 tool(s)...');
console.log('     ... (tool loop) ...');
console.log('     [dm-responder] Tsai Wei-Ming replied to Shin Park (DM ...)');
console.log('');
console.log('TAVILY QUOTA NOTE:');
console.log('   Tavily free tier is 1000 searches/month (~33/day). With 3 agents');
console.log('   (Ayaka + Wei-Ming + Jae-won) you can do roughly 8 searched DMs/day');
console.log('   per agent before the daily quota dies. If you need more, options are:');
console.log('   - Tool result caching (Day 5.5 backlog)');
console.log('   - Paid Tavily (~\$30/mo for 4000 searches)');
console.log('   - Tighter prompts to reduce search count per DM');
console.log('');
