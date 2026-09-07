# gc-assets – öffentliche Marken-Assets von GreenCareers

Statisches Asset-Hosting über GitHub Pages, erreichbar unter **https://assets.green-careers.de/** (IONOS-Wildcard `*.green-careers.de → frdlnk-gc.github.io`).

Zweck: Bilder, die von außen per URL geladen werden müssen – vor allem Logos in automatischen E-Mails (Make-Gmail-Module), wo Base64-Bilder von Gmail blockiert werden.

| Datei | Verwendung |
|---|---|
| `mail/logo-gc-white@2x.png` | Weißes GreenCareers-Logo auf dunklem Header (E-Mails), 300 px breit = 150 px Anzeige |
| `mail/logo-gc-dark@2x.png` | Dunkles GreenCareers-Logo auf hellem Grund, 300 px breit = 150 px Anzeige |

Regeln: Dateien **nie umbenennen oder löschen** – sie sind in laufenden Make-Szenarien verlinkt. Neue Assets mit sprechendem Namen ergänzen, `@2x` = doppelte Pixel für Retina.
