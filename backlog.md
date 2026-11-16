# Backlog

Produktfokuserad backlog. Operativa sidospår (lokala modeller, namn, domän) hör inte hit.

## Nästa

### D1: Automatiseringsförslag för planposter
**Status: klart** (mergad i #70)
- Regelbaserade förslag från godkända planposter.
- Innehåll: steg, assertions, testdata, plan.
- Människan granskar, redigerar, godkänner, avvisar eller ignorerar.
- Apply skapar alltid draft, aldrig approved.
- Ingen modell, inget nätverk, ingen extern integration.

### D2: Automatiseringsförslag för krav
**Status: klart** (mergad i #75)
- Samma mekanism som D1, men för godkända krav.
- Återanvänder D1:s mönster.

### E1: Spec-förslag för planposter
**Status: klart** (mergad i #78)
- Playwright-spec från godkänd planpost, fast mall med test.fixme, utan påhittade selektorer eller URL:er.
- Texten kan redigeras och ändringarna syns i historiken. Apply registrerar vem som applicerade; först därefter kan filen laddas ner.

### E2: Spec-förslag för krav
**Status: klart** (mergad i #80)
- Samma mekanism som E1, men för godkända krav. Filnamn req-<nummer>-<titel>.spec.ts; radering av ett krav tar bort dess spec-förslag.

### E: gemensamma regler för E1 och E2
**Status: klart** (E1 och E2 är mergade)
- Från godkända krav och planposter, föreslå Playwright-spec-filer.
- Samma ägarskapsmodell som D1 och D2.
- Förslaget är draft. Människan granskar, redigerar, godkänner, avvisar eller ignorerar.
- Apply skapar en draft-spec, aldrig en färdig eller körd.
- Ingen körning, ingen extern AI, ingen integration.
- Ingen kodgenerering utan mänskligt beslut.

### G: Buggrapport från skärmdump
**Status: klart** (mergad i #83)
- Testaren bifogar en skärmdump och en kort notis. En fast regel (ingen modell, inget nätverk) gör ett draft-bugförslag: titel från notisens första rad, steg som TODO-skelett, expected/actual som TODO.
- Skärmdumpen sparas som bevis och analyseras aldrig. Den verifieras via sin riktiga header (png/jpg/webp/gif, max 5 MB) och visas bara via egen route (attachment, nosniff, endast inloggade medlemmar).
- Samma ägarskapsmodell som D/E. Apply skapar en bugg som förblir proposed (källa manual, ursprung $screenshot, SCR-n), en gång per draft, och accepterar den aldrig.

### F-A: Kör specen själv ("Run it yourself")
**Status: klart** (mergad i #85)
- Efter Apply visar spec-kortet en ruta: TestBench kör inget. Rutan ger exakt kommando (`npx playwright test <fil>`), var filen ska ligga (`testDir`), hur appen under test pekas ut (`baseURL` i Playwright-configen) och hur resultatet kommer tillbaka (Import-sidan: Playwright JSON, JUnit XML eller zip; CI kan skicka resultat).
- "Runnable" visas bara när `test.fixme` är borttaget, annars en varning. En notis visar hur många TODO-rader som finns kvar. Rutan säger "TestBench has not checked it" och påstår aldrig att testet är korrekt.
- Ingen exekvering, ingen sandbox, ingen ny route, inga nya tabeller.

### F-B: Kör specen i TestBench (sandbox)
**Status: väntar** (görs bara om det verkligen behövs; kräver en egen, godkänd säkerhetsplan först)
- En spec är kod som en människa har redigerat. Att köra den på servern ger vem som helst med rollen tester möjlighet att köra kod på maskinen som håller all data. Node ensam kan inte begränsa nätverk eller filer: det kräver container eller OS-sandbox.
- Villkor att besluta om innan någon kod skrivs: endast admin och en inställning som är av som standard, bekräftelse per körning med exakt kommando och filens hash, loopback-mål, tom miljö utan hemligheter, tidsgräns och storleksgräns på utdata, kill switch, revisionslogg, ingen scheduler och ingen väg för AI eller token att starta en körning.
  - Gäller att köra *specar* i en sandbox. Schemalagda suites (se S nedan) gör bara en manuell run med otestade fall och kör ingen kod, så de kringgår inte villkoren ovan.
- Passar bättre efter den lokala skrivbordsappen.

### S: Körbara suites och schemaläggning
**Status: klart** (mergad i #91, #92, #93 och #95; docs i #96)
- En suite är en körbar grupp av testfall (tabellen `run_templates`). Fliken Suites visar dem; Run gör en manuell run.
- En suite kan ha ett schema: dag eller veckodagar, tid, tidszon eller egen cron, med förhandsvisning och ett schemalogg (started, skipped_overlap, skipped_empty, missed, error). Minst 15 minuter mellan körningar, högst två timmar sen körs, annars missed. `TESTBENCH_SCHEDULER=0` stänger av timern.
- En schemalagd körning är en manuell run märkt Scheduled. Inga automatiserade tester startas, ingen kod körs, ingen ny extern integration.

### T: Trigger från UI (förfrågningar till en agent)
**Status: klart** (mergad i #98 och #99)
- En tester ber en agent att göra en discover av en adress, eller att köra om de failade automatiska testerna i en run (Automated tests → Requests, och på run-sidan). **TestBench startar inget:** förfrågan väntar tills en agent med en request-token (`tbrq_`, en fjärde sorts agent-token med tre routes och inget mer) tar den.
- Tillstånd: Waiting, Taken, Done och Cancelled. Att ta en förfrågan är ett atomärt steg, så två agenter kan inte ta samma. Högst 20 väntande per projekt, adress utan lösenord, och händelserna loggas i audit-loggen.
- Skillen `/testpilot-requests`: användaren väljer **en** förfrågan, agenten tar den och hanterar den via `discover` (med alla stopp) eller en bekräftad Playwright-omkörning (kräver `permissionMode: full`, och rapporten importeras av användaren), och markerar den klar efter användarens bekräftelse.
- Adress och anteckning är data, aldrig instruktion, och en förfrågan bekräftar ingenting (inte produktion, inte scope, inte kommando). Se `docs/agent-requests.md`.

### T-A: Släpp och audit-länk för förfrågningar
**Status: planerad** (nästa)
- **Släpp:** en route `release` för request-token (Taken → Waiting, bara för den token som tog förfrågan, med en anteckning om varför). Idag blir en förfrågan som en agent tagit men inte slutfört kvar som Taken tills någon avbryter den i UI. Ingen schemaändring, bara en ny övergång. Skillens steg 8 släpper den i stället för att lämna den.
- **Audit-länk:** en kolumn `result_audit_id`, och `complete` tar `resultAuditId`, så att en klar discover länkar till sin audit i UI i stället för att audit-id:t står som text i anteckningen. Skillen skickar `auditId` från `deliver`.
- Varför nu: de är de två skavanker vi själva pekade ut när #98 och #99 mergades. De är små och hänger ihop (samma routes, samma token-tester, samma skill-steg).
- Request-token ändrar fortfarande bara status på en förfrågan. Den får inte skapa eller avbryta någon.

### T-B: Automatisk import av re-run-rapporten
**Status: pågår** (beslutat: route på request-token, sju villkor, två PR:er; PR 1 = servern, PR 2 = UI och skill)
- Idag skriver agenten en rapportfil för en omkörning och användaren importerar den, så förfrågan blir aldrig länkad till en run.
- Förslag: en fjärde route på request-token, `POST …/requests/:rid/result`, som bara tar en rapport för en förfrågan som just den token tagit, och som återanvänder CI-importens storleks- och formatkontroller. `resultRunId` sätts då automatiskt.
- Beslut (taget): request-tokens löfte "bara status" utvidgas till att den också får lämna en omkörnings rapport. Alternativet, en CI-token (`tbci_`) i agentens händer, valdes bort: det är en andra och bredare credential, och CI-rutten gör buggar, inte en run.
- De sju villkoren: av som standard (installationsinställning, bara ägaren); bara en omkörning som just den token tagit; bara en gång (även om en människa tar bort runen); bara tester som förfrågan nämnde, annars nekas hela rapporten; miljön kommer från förfrågan; runen märks `source: agent` och länkas till förfrågan; högst 5 MB, bara Playwright-JSON, inga bilagor, med audit-händelsen `agent_request.result_delivered`. Agentresultat räknas som vanliga resultat, märkta men med.
- PR 1 (servern) är byggd. PR 2: knappen i Settings, märkningen på runen och på förfrågans kort, och skillens nya steg `result`.
- Gäller bara re-run. Att starta en CI-körning (GitHub Actions) för en omkörning är ett separat alternativ, och väntar tills någon har sina tester i CI och inte lokalt.

## Backlog

### Bug screenshot → AI-förslag (AI-delen)
G är klart som regelbaserad första version. Det som återstår:
- AI tittar på skärmdumpen och föreslår titel, steg, förväntat/aktuellt beteende, rotorsak, ändring.
- Kräver riktig modell och prompt injection-skydd (se Säkerhet och AI).
- Människan granskar och beslutar. Godkänt förslag blir draft, aldrig automatiskt färdig bugg.
- Ingen kodgenerering, testkörning eller extern integration i första versionen.

### Release-check skill
- Egen checklista innan release.
- Krav, tester, buggar, gaps, release notes, risk.
- Producerar granskningsrapport, blockerar inte release automatiskt.

### Projektöversikt
- Översikt över projekt, audits, status, öppna gaps.

### Reviewer-fält
- Tydligare granskningsroll.

### Beslutslogg
- Mer strukturerad beslutsspår.

### Fler audit-vyer
- Fler vyer över audit-data.

### Statusfilter för gaps
- Samma filter som planposter.

### Indikator för dolda avvisade
- Tydligare indikering i kravvyn.

### Buddy-animation vid discover/run
UI/UX.
- När användaren trycker på “Discover” eller “Run” visas Buddy (handyman-maskoten) som en del av “systemet tänker/arbetar”-animationen.
- Buddy visas med enkel animation (t.ex. puls, tänkande, spinner) medan discover/run pågår.
- Animationen är kosmetisk och påverkar inte logik eller tester.
- Ingen ny data, ingen ny route, ingen integration.
- Kontrast/layout körs opt-in vid visuell ändring.

### Lokal app (desktop)
Separat fas, inte en del av D.
- Gör om TestBench till en lokal skrivbordsapp.
- Behåll webb-tekniken (samma React-gränssnitt och Fastify-server). Paketera med Electron eller Tauri; valet är öppet.
- Data lagras lokalt och ingen hosting krävs.
- Databasen är redan SQLite (`better-sqlite3`) i en lokal fil (`TESTBENCH_DATA`). För appen gäller att lägga filen i användarens datamapp, med backup och migrering.
- Bygg installatör för macOS och Windows.

## Säkerhet och AI

### Prompt injection
- Relevant när riktig AI läser externa eller användarinskickade texter.
- AI får aldrig bestämma, godkänna, köra eller ändra något.
- AI får bara föreslå.
- All inmatning behandlas som data, aldrig som instruktion.
- Alla AI-förslag är draft och kräver mänskligt beslut.
- Ingen AI-funktion får mer behörighet än användaren.
- Verktyg med side effects kräver alltid explicit bekräftelse.

### AI-agent väg
- Riktig agent kan skicka förslag via propose-token.
- Förberedd i datamodell, ej aktiverad.

### Kodgenerering
- AI föreslår kod.
- Ej påbörjad.

### Testkörning
- AI kör tester.
- Ej påbörjad **i TestBench**: TestBench kör inga tester själv, varken på servern eller åt en AI.
- Notis: en agent kan nu köra *användarens egna* Playwright-tester i användarens miljö, efter att användaren bekräftat det exakta kommandot och miljön, och bara med `permissionMode: full` (`/testpilot-requests`, se T). Det är agentens körning på användarens maskin och inte TestBench, så raden ovan gäller fortfarande.

### Extern AI-integration
- Modell bakom förslag.
- Ej påbörjad.

## Integrationer

Medvetet skjutna upp:

- Jira
- Azure DevOps
- Confluence
- GitHub Issues
- Linear
- Dokumentimport (Word, Markdown, Confluence)

## TestPilot

### Kärna
- Mergad.

### Kvar
- Schema-subset-gränser.
- Limitsräkning.
- Deliver-test.
- Riktigt API-test mot produktionsmiljö.
