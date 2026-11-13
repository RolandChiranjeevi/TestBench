# Vision

TestBench är en AI-assisterad testmiljö där människan äger kraven och besluten, medan AI hjälper till att föreslå, förklara och förbereda.

> Människan bestämmer vad som är sant.  
> AI hjälper till att föreslå, förklara och förbereda.  
> Allt AI-genererat är tydligt märkt och förblir ett förslag tills en människa aktivt tar ansvar för det.

## Kärna

- Människan skapar och äger krav.
- AI föreslår testfall, buggar, manuella steg och automatisering.
- Människan granskar, redigerar, godkänner, avvisar eller ignorerar.
- Inget blir "sant" eller färdigt utan mänskligt beslut.
- Flera projekt kan köras parallellt utan datakorsning.
- Externa integrationer är inte kärnan just nu.

## Principer

- AI föreslår, människan bestämmer.
- Allt AI-genererat är tydligt märkt.
- Inget AI-genererat blir automatiskt godkänt.
- Människan har alltid sista ordet.
- Säkerhet och spårbarhet är grundläggande.
- Externa integrationer är valfria, inte kärnan.

## TestBench — samlingsplatsen

TestBench är en lokal app på användarens dator som samlar allt som rör test: krav, testfall, testkörningar, observationer, buggar och annan testrelaterad information.

En användare kan:

- Skapa, redigera och godkänna **krav** (manuellt, via import från Jira/Azure/dokument, eller som AI-förslag baserat på observationsluckor).
- Skapa och hantera **testfall** — både manuella och automatiserade.
- Organisera testfall i **suites** (mappar), och köra ett urval eller ett enskilt testfall som en **run**. Att köra en hel suite som en körbar grupp är ett mål, inte byggt än. Se "Suites och runs" nedan.
- Köra tester **manuellt** (användaren kör själv) eller **automatiserat** (TestPilot-agenten kör).
- Se **observationer** från körningar — avvikelser, säkerhetsproblem, tillgänglighetsproblem.
- Konvertera observationer till **buggrapporter** med beskrivning av felet och eventuell föreslagen fix.
- Se **spårbarhet**: när en körning gjordes, vad som framkom, vilka testfall som kördes, vilka som failade.
- Hantera **konton och roller** (Owner, Admin, Tester, Viewer) med rätt behörigheter.
- Trigga **TestPilot** direkt från UI:t — starta en ny discover, eller köra om automatiska testfall.

## Suites och runs

Orden "suite" och "run" betyder olika saker och ska hållas isär:

- **Suite som mapp / organisationsstruktur — finns redan.**
  Ett träd av mappar (`suites`) där varje testfall ligger i en mapp. Används för att sortera och hitta testfall, med dra och släpp i testfallslistan. En suite i den här betydelsen går inte att köra som helhet.
- **Suite som körbar grupp av testfall — saknas.**
  Ett namngivet, sparat urval av testfall som kan köras som en enhet, och som kan blanda manuella och automatiserade testfall. Den ska inte klämmas in i mappträdet; den är en egen sak. Run-mallar (`run_templates`) är närmast, men de är bara ett sparat urval för manuella runs.
- **Run som enskild eller vald körning — finns för manuella tester.**
  En körning av ett enskilt testfall, ett urval eller en run-mall, med resultat per testfall och per steg. Automatiserade runs kommer in som importerade resultat (CI, uppladdning, GitHub Actions), men TestBench startar dem inte själv.

Målet är att båda finns: körbara suites för stora grupper, och runs för enskilda eller valda testfall.

## TestPilot — AI-agenten

TestPilot är AI-agenten som drivs från TestBench och arbetar enligt flödet:

**discover → plan → run → report → deliver**

- **Discover:** utforskar en sida/app och föreslår testfall (både automatiserade och manuella för människan) inom agentens skill.
- **Plan:** skapar en testplan med omfattning, begränsningar och stoppvillkor.
- **Run:** kör de automatiserade testfallen.
- **Report:** skapar observationer för avvikelser, säkerhetsproblem, tillgänglighetsproblem, och föreslår buggar vid behov.
- **Deliver:** levererar resultatet tillbaka till TestBench.

## Viktiga komponenter

- **Playwright MCP** — central för webb-UI-testning.
- **Claude** — AI-motorn för agenten.
- **Design-review skill** — täcker WCAG 2.2 AA som en del av design-granskning; ingen separat accessibility-skill. Automatiska kontroller ger inte full konformitet.
- **API-testing skill** — för API-testning.
- **Loadtest + security-review skills** — för belastning och säkerhet.

## Säkerhet och spårbarhet

- **Target profiles** med `observe_only` (default) eller `full` (kräver explicit godkännande).
- **Agent-rules** som gemensam regelbok (observe-only default, inga hemligheter i klartext, konkreta begränsningar).
- **Audit contract / package format** för spårbarhet (manifest, executions, evidence).
- **Delivery till TestBench** (`deliveryEnabled`) — agenten kan leverera paket till TestBench.

## Testfall i spec.ts

Automatiserade testfall ska skrivas i **Playwright-format (`*.spec.ts`)**, så att de kan köras av TestPilot och underhållas som vanlig kod. Ett AI-genererat spec är ett förslag som en människa godkänner innan det körs.

## Integrationer

**Finns redan:**

- **Jira och Linear** — export av buggar.

**Framtida:**

- **Azure DevOps** — export av buggar/krav/testfall.
- **Mobilappstest** — t.ex. via BrowserStack eller liknande (stor scope).

## Arkitektur

- **TestBench och TestPilot är sammanslagna till ett repo.** TestPilots skills ligger i `.claude/skills/` och dess verktyg under `testpilot/`. Suite-modellen, triggern från UI och spec.ts-stödet byggs mot den strukturen.
- **TestBench är en lokal app** på användarens dator, med tillgång till internet.
- **Trigger från TestBench UI** till TestPilot är nyckel-UX — användaren ska kunna starta discover eller köra om automatiska tester direkt från TestBench.

## Vad som redan är byggt

- Konton + roller (5a–5d).
- Requirements, test cases, runs, observations, bugs, agent proposals — kärnan finns.
- **Manuell testkörning — komplett:** runs med status, resultat per testfall och per steg, run-mallar, omkörning av misslyckade och manuella testförslag från agenten som kan bli testfall.
- **Suites som mappträd** för testfall.
- Import av automatiska testresultat (Playwright, TestCafe, Selenium, Bruno, JUnit) via CI, uppladdning och GitHub Actions.
- **Jira- och Linear-export av buggar.**
- API-testing skill (PR #10 + säkerhetsfixar).
- Loadtest + security-review skills.
- Target profiles + permission modes + agent-rules + audit contract.
- Delivery till TestBench (`deliveryEnabled`).
- WCAG 2.2 AA i design-review skillen.
- **TestBench och TestPilot i ett repo** — TestPilots historik är nåbar via `git log --follow` eller `--full-history`.

## Vad som saknas / behöver byggas

- **Suite som körbar grupp av testfall** — se "Suites och runs".
- **Trigger från TestBench UI** — kör discover / kör om automatiska tester.
- **Användarskapade automatiserade testfall (spec.ts)** — ej byggt.
- **Azure DevOps-export** — framtida.
- **Mobilappstest** — framtida.

## Nästa steg

1. **Suite-modell** — suite som körbar grupp av testfall, och körning av suites. Nästa steg nu när repona är sammanslagna.
2. **Trigger från UI** — nyckel-feature för att knyta ihop allt.
3. **Användarskapade automatiserade testfall (spec.ts)** — bygg efter suites och trigger.
4. **Integrationer (Azure DevOps, mobil)** — senare.

## Frågor att förtydliga

- **Körmiljö för triggern** — vad startar agenten (Claude Code CLI, Agent SDK eller API), var körs den, och vem betalar?
- **Ägande av spec.ts** — i databasen, som filer på disk eller i användarens git-repo? Hur isoleras de när de körs?
