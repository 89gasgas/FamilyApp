# FamilyApp: stato del progetto e istruzioni per Claude

Ultimo aggiornamento: 6 novembre 2026

Questo file è la memoria di lavoro del progetto: chi apre una nuova chat parte da qui.
La fonte di verità delle specifiche è il documento **FamilyApp / App Famiglia: Specifica**:
https://claude.ai/artifact/Gae2xgFmM5QryMa35cSR4L (Claude Docs, id 7e2b727b-61c5-4f04-91fb-8b85296870b9)

## Chi e cosa
- Utenti: GaS (Gabriele) e Chips (sua moglie). Abitano a Racconigi (CN). Entrambi Android.
- App personale per la famiglia: lista della spesa, to-do, calendario condiviso, ricorrenze, liste libere, archivio documenti, spese/finanze.
- Nome dell'app: FamilyApp.

## Metodo di lavoro (requisiti di GaS)
- Sviluppo guidato dalle specifiche: GaS scrive e approva le specifiche e fa il collaudo, ma non legge il codice. Claude sviluppa, testa e mostra i risultati.
- GaS segue e risponde dal cellulare; Claude lavora in autonomia.
- Claude accede SOLO alla cartella `C:\Users\gabri\Desktop\FamilyApp`: mai altri file, lo schermo o il browser del PC.
- **Requisito primario: tutto gratuito.** Nessun servizio a pagamento.
- Le chiavi stanno solo in `Segreti.txt` in questa cartella: mai in chat, nei documenti o nel repository.

## Decisioni prese
| Tema | Decisione |
| --- | --- |
| Tipo di app | PWA installabile (icona sulla Home, schermo intero), niente Play Store |
| Backend | Supabase, piano Free, regione Central EU (Frankfurt) |
| Hosting | Vercel, piano Hobby |
| Codice | GitHub, repository privato `FamilyApp` (utente 89gasgas) |
| Accesso | Account Google (solo GaS e Chips) |
| Calendario | Integrato con Google Calendar, non ricostruito |
| Spesa | Una sola lista; i comprati restano barrati e attenuati in fondo e si riattivano; ordine personalizzato = percorso del supermercato |
| Volantini | Link a Lidl (via Principessa di Piemonte 1) e Mercatò Local (C.so Principi di Piemonte 45), Racconigi |
| Escluse | Menu settimanale, posizione in tempo reale |
| Rimandato | Perimetro di spese e finanze |

Vincoli del piano Free di Supabase da gestire: pausa dopo 7 giorni di inattività (serve un controllo giornaliero che tenga attivo il progetto) e nessun backup automatico (serve un backup giornaliero gratuito, es. GitHub Actions).

## Roadmap
1. Fondamenta + lista della spesa condivisa (user story SP-01…SP-07 nel documento)
2. To-do condivise
3. Notifiche
4. Calendario (integrazione Google Calendar)
5. Spese e finanze
6. Ricorrenze e promemoria
7. Liste libere (film, libri…)
8. Archivio documenti
9. Miglioramenti

## Stato del setup (6 nov 2026)
- [x] Cartella `FamilyApp` sul Desktop, accesso concesso a Claude
- [x] Account GitHub, Supabase, Vercel creati; `Segreti.txt` compilato (7 voci: GITHUB_USER, GITHUB_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_DB_PASSWORD, SUPABASE_ACCESS_TOKEN, VERCEL_TOKEN). Formato verificato, funzionamento non ancora verificato.
- [x] **Rete RISOLTA (6 nov 2026, Claude Code desktop sul PC).** api.github.com 200, api.supabase.com 401 e api.vercel.com 403 senza chiavi (cioè raggiungibili), github.com, vercel.com e supabase.com 200. Il blocco riguardava solo le sessioni cloud e Cowork.
- [x] **Chiavi verificate (6 nov 2026)** con `scripts/check-keys.sh`, che stampa solo i codici: GitHub utente 200, repository `FamilyApp` 200, Supabase management 200, Supabase auth health 200, Vercel 200. La radice REST di Supabase risponde 401 con la chiave pubblica: è normale. SUPABASE_DB_PASSWORD non ancora provata, servirà alla prima connessione al database.
  - Permesso: `.claude/settings.local.json` autorizza solo `sh scripts/check-keys.sh`. Claude non legge `Segreti.txt` direttamente: le chiavi si usano solo tramite script che non le stampano. Ogni nuovo script che usa le chiavi richiederà una regola analoga.
- (storico) Dalla sessione cloud e da Cowork, Supabase, Vercel e GitHub risultavano bloccati dal proxy.
  - GaS ha aggiunto i domini su claude.ai/code (ambiente cloud), ma non ha avuto effetto sulla sessione Cowork.
  - Il messaggio del proxy indica claude.ai → Settings → Capabilities (piani individuali) come posto giusto. Da verificare.
  - Domini necessari: github.com, api.github.com, supabase.com, api.supabase.com, *.supabase.co, vercel.com, api.vercel.com
  - Per GitHub potrebbe servire anche collegare l'account GitHub a Claude.
- [ ] Lista iniziale della spesa (in ordine di supermercato) da ricevere da GaS
- [ ] Icona dell'app (facoltativa)
- [ ] Rilettura delle user story da parte di Chips

## Primo passo in una nuova chat
1. Leggere questo file e il documento di specifica.
2. Verificare la rete: chiamate di prova a api.github.com, api.supabase.com e api.vercel.com con le chiavi di `Segreti.txt`, stampando solo i codici di stato e mai le chiavi.
3. Se la rete funziona, partire con l'incremento 1. Altrimenti guidare GaS sull'impostazione dei domini.
