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

### U: Användarskapade automatiserade testfall (spec.ts)
**Status: klart** (tre PR:er: S1, S2, S3)
- **Ägande (beslutat):** användarens repo är källan. TestBench har en kopia som text, med revisioner och nedladdning, och en jämförelse mot den uppladdade eller inklistrade filen (hash och text: "samma" eller "skiljer sig"). TestBench skriver aldrig till disk eller git och kör aldrig en spec (F-B ligger kvar och väntar på en egen säkerhetsplan).
- **S1: spec från ett testfall. Status: klart.** Knappen "Create spec" på ett `ready`-testfall. Samma mall som E1 och E2, men varje steg har sitt förväntade resultat (saknas det blir det en TODO-rad, inget hittas på). Titeln slutar med ärendets tagg `@<NYCKEL>-<nummer>`, så importerade resultat länkas till ärendet. Filnamn `tc-<nummer>-<titel>.spec.ts`, `test.fixme` kvar, Apply först efter granskning. `subject_kind = 'case'` utan ny kolumn eller tabell; en trigger tar bort förslagen när ärendet raderas (en, flera eller hela projektet). E1 och E2 ger exakt samma text som förut.
- **S2: egna specar. Status: klart.** Egen tabell `specs` (och `spec_revisions`, inte `automation_suggestions`): platta filnamn som slutar på `.spec.ts` (högst 80 tecken, unika per projekt utan hänsyn till versaler), text högst 204 800 byte (UTF-8) som aldrig är tom, högst 500 specar per projekt, status draft eller ready, valfritt ärende i samma projekt (töms av sig självt när ärendet raderas), vem som skapade och senast ändrade, och revisioner (created, edited, renamed, status, case; en ändring utan effekt ger ingen post). En flik **Specs** under Automated tests: skapa, redigera i en textruta, byta namn, ta bort och ladda ner, med rutan "TestBench does not run this. Your repo is the source; this is a copy." och en varning om att inte klistra in hemligheter. Tester och admin skriver, viewer läser och laddar ner. **Säkerhet:** bara inloggade projektmedlemmar via UI. Ingen agent-token får skapa, ändra, ta bort, läsa eller lista egna specar, och det bevisas med tester för alla fyra tokentyper på alla sju routes, både läsning och mutation, med och utan webbläsarheadern. Med konton nekar databasen (trigger) en skrivning utan en person. Audit-händelserna `spec.created`, `spec.edited`, `spec.renamed` och `spec.deleted` spelar in den inloggade användaren och aldrig texten. Projektets raderingsbekräftelse räknar specarna. Ingen agentväg, ingen skrivning till disk eller git, ingen körning, ingen automatisk sökning efter hemligheter.
- **S3: koppla specen till resultaten. Status: klart.** (1) **Resultat:** specens kort visar de importerade testerna vars fil är specens namn eller slutar på `/<namn>` (utan hänsyn till versaler, snedstreck normaliseras): antal tester, passed, failed, skipped, blocked, senast sedd, filerna (flera olika filer listas alla med en tydlig varning) och upp till 20 titlar med länk till sitt ärende. Listan visar filen, en kort bricka ("1 failed", "passed", "no results") och senaste tid. Ingen ny tabell eller kolumn. (2) **Compare with my repo:** användaren laddar upp eller klistrar in filen; servern (`POST /api/specs/:id/compare`) svarar `same`, `same except line endings` (lika efter CRLF/CR till LF och utan avslutande nyrader) eller `differs`, med båda hasharna (SHA-256), storlekar och antal rader tillagda/borttagna (exakt upp till en gräns, därefter "about"). Fel filnamn är en varning, inte ett nej; tom fil, fil med NUL och text över 204 800 byte nekas. Jämförelsen sparar och loggar ingenting och är öppen för viewer. **Use the repo version** sparar den jämförda texten som en vanlig ändring (ny revision) med en valfri anteckning (högst 200 tecken, syns i historiken; aldrig i audit-loggen). Ingen agentväg: alla fyra tokentyper nekas på alla åtta routes. (3) **`@REQ-n`** i titeln på nya krav-specutkast (E2); E1 och befintliga utkast är oförändrade. Tagget ger täckning först när testet är länkat till ett ärende (importen läser det bara då).

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
**Status: klart** (mergad i nästa PR)
- **Släpp:** en femte route `release` på request-token (Taken → Waiting). Bara den token som tog förfrågan, bara medan den är Taken, och inte efter att en omkörnings rapport lämnats in (då avslutas den med `complete`). En anteckning om varför, vem och när sparas (`release_note`, `released_by`, `released_at`) och visas på kortet medan förfrågan väntar. Audit-händelsen `agent_request.released`. Skillen frågar användaren före släpp, i ett nytt meddelande, och gör inget utan ett ja.
- **Audit-länk:** kolumnen `result_audit_id` (töms om auditen tas bort), och `complete` tar `resultAuditId` för en discover. Auditen måste vara i samma projekt och ha importerats efter att förfrågan togs (importen görs med en persons inloggning, så servern kan inte veta vems den är, men den kan neka en äldre). Kortet visar "Audit: titeln" som länk till Bug reports → Audits (`?audit=<id>`). Skillen skickar `auditId` från `deliver`.
- Request-token ändrar fortfarande bara status på en förfrågan (och en släpp-anteckning, och länken till en audit). Den får inte skapa eller avbryta någon.

### T-B: Automatisk import av re-run-rapporten
**Status: klart** (mergad i #104 och nästa PR)
- En agent som tagit en omkörning kan lämna in Playwright-rapporten (`POST …/requests/:rid/result` på request-token), och TestBench gör en run av den, länkad till förfrågan.
- Beslut: request-tokens löfte "bara status" utvidgades till detta. En CI-token (`tbci_`) i agentens händer valdes bort: en andra och bredare credential, och CI-rutten gör buggar, inte en run.
- De sju villkoren: av som standard (installationsinställning, bara ägaren, knapp i Settings → Agent); bara en omkörning som just den token tagit; bara en gång (även om en människa tar bort runen); bara förfrågans egna tester, annars nekas hela rapporten; miljön från förfrågan; runen märks `source: agent` (chip "Agent" i listan, "Handed in by agent" på run-sidan, och på förfrågans kort); högst 5 MB, bara Playwright-JSON, inga bilagor, och inga andra tester länkas om. Audit-händelsen `agent_request.result_delivered`. Agentresultat räknas som vanliga resultat, märkta men med.
- Skillen `/testpilot-requests` har en åtgärd `result`: den visar exakt vad som skickas (fil, storlek, antal tester, förfrågan, adress) och skickar först efter ett ja i ett nytt meddelande, en gång. Är funktionen av, eller svarar användaren nej, importerar användaren filen som förut.
- Gäller bara re-run. Att starta en CI-körning (GitHub Actions) för en omkörning är ett separat alternativ, och väntar tills någon har sina tester i CI och inte lokalt.

### AG-A: MCP-brygga över befintlig agentförfrågningskö
**Status: klart** (mergad i #110)
- En lokal MCP-server (`mcp/`, stdio, `@modelcontextprotocol/sdk`, Zod) som Claude/TestPilot startar. Den läser `TESTBENCH_URL`, `TESTBENCH_TOKEN` (en request-token, `tbrq_`) och `TESTBENCH_PROJECT_ID` (request-tokens routes har projektet i adressen).
- `testbench_get_next_request` listar de väntande förfrågningarna och tar den äldsta lediga (`claim`). `testbench_update_request_status` avslutar (`complete`) eller släpper tillbaka (`release`) en förfrågan. `testbench_create_finding` var i AG-A en platshållare ("not supported yet") och blir riktig i AG-B.
- Ingen ändring i TestBench-servern, `agent_requests`, tokens, UI eller något testmaterial. Adress och anteckning är data, aldrig instruktion, och svaret säger det.
- Loggar till stderr (aldrig stdout), skriver aldrig ut token, och mappar 401, 403, 404, 409 och 429 till tydliga fel.

### AG-B: Agent findings (testfall, buggar, observationer, manuella förslag)
**Status: klart** (mergad i #111)
- Ny route `POST /api/agent/projects/:id/requests/:rid/findings` på request-token (den sjätte). Bara den token som tog förfrågan, bara medan den är Taken, och bara för en **discover**: en omkörning får 409 och lämnar sin rapport via `result`. `testbench_create_finding` i MCP-servern är nu riktig.
- `test_case` → `cases` som `draft`, märkt med den token som skapade det (`created_by_agent_token_id`, och taggen `agent-proposed`), utan mapp. `bug_report` och `manual_test_suggestion` → `proposed`. `observation` → ny kind `exploratory`, `observed`, utan audit. Källa `$agent-<förfrågan>` och eget nummer `$agent-<förfrågan>-<n>`. Ett auditpaket kan aldrig skapa `exploratory`.
- Gränser: högst 200 findings per förfrågan (`agent_requests.findings_count`, 409 därefter) och 60 per minut per token (429). Allt i en transaktion, så ett nekat finding lämnar inget spår.
- Audit-händelsen `agent_request.finding_created` som `agent: <namn>` med token-id (`credential_id`), aldrig token eller hash.
- **Ogranskade AI-utkast går inte in i en run av misstag:** Select all, Select shown och mappens kryssruta i testfallsväljaren hoppar över testfall med taggen `agent-proposed` som fortfarande är `draft`. De syns (etikett "Agent draft") och kan kryssas i för hand. Ett testfall som sätts till `ready` är ett vanligt testfall igen.
- Allt agentgenererat granskas av en människa och godkänns aldrig automatiskt. Request-token får fortfarande inte röra specar eller konton, inte heller skapa eller avbryta förfrågningar.

### AG4: Run-förfrågan (be en agent köra valda testfall)
**Status: klart** (mergad i #112)
- Ny kind `run` i `agent_requests` (CHECK byggs om, alla rader och kolumner bevaras). I run-dialogen ("New manual run") finns **Run it myself | Ask an agent**: adress att testa (samma regler som discover), miljö och anteckning, knappen "Ask agent to run (n)". Ingen ny route: `POST /api/projects/:id/agent-requests` tar `kind: "run"`.
- **Runnen skapas vid klicket:** en manuell run med ett tomt resultat per valt testfall, och förfrågan pekar på den (`agent_requests.run_id`, och `meta.agentRequest` på runnen). Run-listan och run-sidan visar "Waiting for agent · request #n", "Taken by agent: …", "Agent finished" eller "Request cancelled". En person kan fortfarande fylla i resultat för hand. En suite som dialogen öppnades från följer med.
- **Payload (en ögonblicksbild):** `runId`, `targetUrl`, `environment`, `note` och per testfall `caseId`, `key`, `number`, titel, beskrivning, förutsättningar, prioritet, steg (med id), namn på kopplade automatiserade tester och spec-filnamn. **Aldrig** spec-text, krav-text, bilagor, skärmdumpar eller något annat. Testfallens text skickas till agenten: dialogen och docs varnar för att lägga hemligheter i testfall (ingen skanning).
- Gränser: 1–200 testfall, högst 1 MB text (annars 400 "pick fewer", utan avkortning), inga deprecated testfall, och de 20 väntande per projekt gäller. Allt görs i en transaktion.
- **Listor bär bara `caseCount`**, aldrig testfallens text. Hela payloaden kommer när agenten tar förfrågan. En förfrågan vars run har raderats erbjuds inte och kan inte tas, men kan avbrytas.
- Agenten kan ta och släppa (`release`) en run-förfrågan. `complete` ger 409 tills varje testfall har ett resultat (AG5a). MCP `testbench_get_next_request` visar `kind: "run"`, `runId`, adress, miljö och testfallen, och säger att testfallens text är data och att agenten aldrig får hitta på ett resultat.
- Audit: `agent_request.created` med `{ request, kind: "run", run, cases }`, och claim, release och cancel loggas på samma sätt.

### AG5a: Resultat per testfall
**Status: klart** (mergad i #113)
- `POST /api/agent/projects/:id/requests/:rid/case-results` och MCP-toolen `testbench_report_results`. **Varje anrop är en batch, allt eller inget** (1–200 resultat, högst 256 kB, 60 anrop per minut per token, annars 429): en refuserad batch lämnar inget spår. Agenten får rapportera flera gånger, men **varje testfall bara en gång**. Allt kontrolleras och skrivs i en transaktion tillsammans med audit-raden.
- Bara `run`-förfrågningar, bara token som tog den, bara medan den är Taken, och bara när en person har slagit på den befintliga omkopplaren *Agent results* (av som standard, bara ägaren, eftersom resultaten räknas direkt för testfallets status, täckning och kravstatus). Är den av ger routen 409 och inget skrivs.
- Tillåtna värden `passed|failed|blocked|skipped` (aldrig `untested`; agenten rapporterar `inconclusive` som `blocked`). `note`, `error` och stegets `actual` högst 2000 tecken, `durationMs` valfritt, stegresultat `{stepId, status, actual}` där steget måste höra till testfallet i förfrågan. Fält som inte finns i schemat nekas. Tiden (`executed_at`) sätts av servern.
- **Agenten skriver aldrig över en människa:** ett resultat får bara skrivas om det är helt orört (status `untested`, ingen `executed_at`, inga anteckningar, ingen länkad issue, inga stegresultat, inga bilagor, och inget agentmärke). En person som har satt, ändrat, återställt till `untested`, kommenterat eller bifogat något räknas som att ha rört det, och ett resultat som agenten redan rapporterat rapporteras inte igen.
- Kolumnen `results.reported_by_agent_token_id` märker agentens resultat och **stannar kvar** när en person ändrar dem (spårbarhet). Run-sidan visar etiketten "Agent: <namn>" med tipset "Reported by agent. A person may have changed it." i listan och i detaljen, och "n of M results recorded (includes manual results)" på förfrågan och på runnen (räknar varje testfall som har ett resultat, vem som än satt det, och tipset säger att en person kan ha ändrat agentens resultat).
- `complete` kräver ett resultat för varje testfall som fortfarande finns, vem som än satt det (annars 409 "N of M test cases have no result yet"). **Runnen förblir `in_progress`**: en person granskar och avslutar den, agenten gör det aldrig. `release` fungerar med delvisa resultat, de blir kvar, och förfrågans `progress` (`{total, reported, missing}`) visar en ny agent vad som återstår.
- Audit `agent_request.results_reported` som `agent: <namn>` med `{ request, kind: "run", run, credential_id, reported, passed, failed, blocked, skipped }`, aldrig token eller hash, och en läsbar mening i audit-vyn.
- UI: run-dialogens "Ask an agent" och Settings säger att *Agent results must be enabled before an agent can report results for a run*.
- Skillen `/testpilot-requests` stöder **högst 10 testfall per förfrågan** ("This skill supports up to 10 cases per request": en försiktig MVP-gräns som kan höjas, servern tillåter fortsatt 200) och har en ny ACTION `case-results` (filen under `audits/request-<RID>/`, samma kontroller som `result`, token bara i headern) och ett `run`-flöde: kontrollera `permissionMode` och adress före claim, kör testfallen ett i taget med Playwright MCP, skriv resultatfilen, visa exakt vad som skickas, fråga i ett nytt meddelande, skicka, och `complete` först när alla har resultat. Aldrig ett påhittat resultat.
- Specar får inga resultat i AG5a, de får dem som idag när en person importerar.

### AG5b: Spec- och automatiserad länk
**Status: byggd, väntar på granskning**
- Ingen ny route: agentens Playwright-JSON lämnas in på den befintliga `POST /api/agent/projects/:id/requests/:rid/result` (upstreams `submitResult`), nu för **`run` och `rerun`**. Samma regler som förut: bara token som tog förfrågan, bara medan den är Taken, bara när *Agent results* är på, **en gång per förfrågan**, högst 5 MB, och hela rapporten nekas vid fel. Nytt: **högst 1000 tester** och **10 leveranser per minut per token** (429, även nekade försök räknas).
- **Vad en rapport får innehålla för en `run`-förfrågan:** ett test som är länkat till något av förfrågans testfall (`cases[].automatedTests`, framework + fullName), eller ett test i en av förfrågans spec-filer (`specFiles`), också ett test som TestBench inte känner till än. Det senare behövs för att en nyskapad spec ska få sina första resultat. Allt annat, dubbletter, tom rapport, icke-Playwright eller över gränserna nekar hela rapporten och lämnar inget spår (ingen körning, inga `automated_tests`-rader, ingen audit, ingen markering).
- **Länken bestämmer TestBench, aldrig texten i rapporten** (`resolveLink` i `importReport`): ett känt test behåller sitt `case_id` (även inget, och en människas länk), ett nytt test i en spec-fil från förfrågan får den specens testfall, annars inget. Titel, svit och taggar (`@KEY-n`, `@REQ-n`) länkar ingenting och ger ingen kravtäckning. Samma regel gäller `rerun`, vilket stänger ett hål där taggar i en agents rapport kunde länka om ett känt test till ett annat testfall.
- **Rapporten blir en egen automatiserad körning** (`Automated tests of run #… (request #…)`, `source: agent`, `meta.agentRequest`, `runOf`), länkad från förfrågan och från den manuella runnen ("Automated report: run #N"). Den rör varken den manuella runnen eller AG5a-resultaten, och TestBench kopierar inte de automatiserade resultaten dit: agenten rapporterar testfallens resultat själv via `case-results`, sanna mot rapporten.
- **Specar** får sina resultat av sig själva via filnamnsmatchning (sista ledet, skiftlägesokänsligt, `ambiguous` om två filer har samma basnamn), och **testfall** via länken (täckning, kravstatus och "Last automated" följer det senaste resultatet).
- `release` tillåts efter levererad rapport för `run` (rapporten blir kvar och kan inte lämnas in igen), men fortsatt inte för `rerun`. `complete` är oförändrad.
- Audit `agent_request.result_delivered` skrivs i samma transaktion med `{ request, kind, run, result_run, credential_id, tests, new_tests, linked, passed, failed, skipped }`, utan token eller hash, och en egen mening för `run`.
- Skillen `/testpilot-requests` (högst 10 testfall per förfrågan) kör testfall med `automatedTests` eller `specFiles` med Playwright efter att ha frågat var testerna ligger, hittat filerna med exakt en träff, visat exakt kommando och miljö (produktion kräver de två bekräftelserna) och fått ett ja i ett nytt meddelande; den lämnar in rapporten med `result` efter ett nytt ja och rapporterar sedan testfallens resultat sanna mot rapporten. **Inget nytt MCP-verktyg**: en JSON på upp till 5 MB passar inte som verktygsargument, så MCP får bara en text om hur rapporten levereras.

### TS: Förslag efter jämförelsen med TestSprite CLI
**Status: förslag, inget är påbörjat** (jämförelsen gjordes 2026-11-20 och beslutas på måndag; bakgrunden finns i designmappen utanför repot, `testsprite-jamforelse.md`)
- **TS-A: Repo-hygien i CI.** Vi har bara `ci.yml`. Lägg till dependabot (npm och GitHub Actions), en hemlighetsskanning i CI och en `CODEOWNERS`. Att besluta först: vilken skanner, och en tillåtelselista för de falska tokenmönster som våra tester och mallar använder med flit (till exempel `tbrq_…` i testerna). Storlek: liten.
- **TS-B: Terminal-säker utskrift och ett skrivet kontrakt för hjälparen.** (1) Ett egenskapstest som visar att varje sträng som `request_call.py` skriver ut från serverdata saknar styrtecken, escape-sekvenser samt bidi- och osynliga tecken. (2) Ett kontrakt i docs för hjälparens utdata och exit-koder, testat mot koden. Bakåtkompatibelt: inga befintliga rader ändras. Storlek: liten.
- **TS-C: `testpilot doctor` v1.** Ett kommando som bara läser och aldrig skriver ut en token. Det kontrollerar att token och profil finns, att tillåtelselistan är den ur docs (`git` och `gh` nekade, inget extra tillåtet), att profilen, regelfilen och `origin` hänger ihop (via `spec_git.py check`), och om agentmappens skills ligger efter `origin/main` eller är ändrade lokalt (`ok`, `stale`, `modified`). Storlek: medel. Störst värde av de tre: live-testerna visade att det är uppsättningen som skaver.
- **Egna beslut, inget förslag än:**
  - **TS-D: sluta loopen**, alltså köra specen och få ett resultat per test med orsak och bevis. Bitarna finns (run-förfrågan, `@NYCKEL` i titeln, CI-import, S3). Frågan är gränsen mot principen att TestBench inte kör något (se F-B).
  - **TS-E: fler agenter än Claude Code**, med en installatör per agent och en kontroll av om en skill är gammal. MCP-vägen finns redan.
  - **TS-F: återanvändbar inloggning för obevakade körningar**, med ett lokalt sparat sessionstillstånd. En sparad session är en hemlighet och kräver en egen säkerhetsplan innan något byggs: var den ligger, vem som kan läsa den, livslängd, och att agenten aldrig får läsa filen.
- **Kopieras inte:** telemetri som standard, krediter, att sviten bor hos leverantören, och att en agent kör tester med inloggningsuppgifter i miljön.
- **Öppet, inte undersökt:** hur deras molnrunner undviker oåterkalleliga handlingar på en levande sajt, och var testdata och inloggningar lagras.

### DG: Discover till git (git-läget `local`)
**Status: 3a–3d klara, 3e väntar**
- **Klart:** en discover kan lämna Playwright-specs på en ny lokal gren i användarens egen utcheckning (`spec_git.py`, regelfilen `TESTPILOT.md`, en `Git:`-rad i bekräftelsen, `git` och `gh` nekade, manual i `docs/agent-git-setup.md`). Två live-körningar och ett förbudsprov är gjorda.
- **3e: läget `pr`** (pusha grenen och öppna en PR, aldrig merga). Byggs först efter att skyddet har provats mot ett riktigt engångsrepo på GitHub. Räknas som `local` tills dess.
- **Körning 3 (valfri):** variant `blocked`, där verktyget vägrar på riktigt, för att pröva vägran och den enda rättningen live. I körning 2 såg agenten gränsen i förväg och försökte aldrig skriva.
- **Inte provat:** andra former av `git` (`env git`, `bash -c`, en sökväg, `$(git …)`), en riktig `git push`, och att en människa kör de skrivna specsen mot demosajten.
- **Små förbättringar:** när `check` visar en gräns som gör specs omöjliga bör bekräftelsen säga "Not made" direkt (agenten såg `max-lines: 1` först efter sitt yes). Bilden utan alt-text på demosajten nämndes i ingen körning.

### Senare
- Desktop DevOps (skrivbordsappen, och eventuellt F-B), Azure DevOps och mobilappstest.

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
