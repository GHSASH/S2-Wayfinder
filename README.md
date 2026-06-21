# Pokemon GO Map S2 Cells

Tampermonkey userscript that adds a visual S2 cell overlay to the Pokemon GO web map. The goal is to help plan new Wayspot/Pokestop nominations by showing S2 level 14 and 17 cells, occupied cells, and useful local planning information.

## What The Script Does

- Draws red S2 level 14 and level 17 cell lines.
- Adds `S2 L14` and `S2 L17` toggles directly on the map.
- Hides the grid while the map is moving or zooming to improve performance.
- Shows the grid only when the `Pokestop` map filter is enabled.
- Allows `Gym` and `Pokestop` filters to stay enabled at the same time.
- Fills level 17 cells that already contain a loaded Pokestop or Gym with a light transparent red.
- Shows a level 14 summary when hovering over a cell, including:
  - Pokestop count;
  - Gym count;
  - total loaded objects;
  - expected stop/gym distribution;
  - how many Pokestops are missing before the next Gym threshold.

## Gym Rule Used

The level 14 hover tooltip uses this rule:

| Total in L14 | Expected distribution |
| --- | --- |
| 1 | 1 stop |
| 2 | 1 stop, 1 gym |
| 6 | 4 stops, 2 gyms |
| 20+ | 17+ stops, 3 gyms |

Counts depend on the objects already loaded by the map. To count Gyms and Pokestops together, keep both the `Gym` and `Pokestop` filters enabled.

## Tampermonkey Installation

### 1. Install Tampermonkey

Install the Tampermonkey browser extension:

- Chrome / Edge: search for `Tampermonkey` in the Chrome Web Store.
- Firefox: search for `Tampermonkey` in Firefox Add-ons.

After installation, make sure the extension is enabled.

### 2. Install The Script Manually

1. Open the Tampermonkey dashboard.
2. Click `Create a new script` or the `+` button.
3. Delete the default template content.
4. Copy the full content of `pokemon-go-s2-cells.user.js`.
5. Paste it into the Tampermonkey editor.
6. Save with `Ctrl + S`.
7. Open or reload the Pokemon GO web map.

### 3. Install From GitHub Raw

After the repository is published on GitHub:

1. Open `pokemon-go-s2-cells.user.js` on GitHub.
2. Click `Raw`.
3. Tampermonkey should open the installation screen automatically.
4. Click `Install`.

The raw URL will look like this:

```text
https://raw.githubusercontent.com/YOUR_USER/YOUR_REPOSITORY/main/pokemon-go-s2-cells.user.js
```

## How To Use

1. Open the Pokemon GO web map.
2. Enable the `Pokestop` filter.
3. If you also want Gym counts, enable `Gym` together with `Pokestop`.
4. Use the `S2 L14` and `S2 L17` controls on the map.
5. Hover over a level 14 cell to see the Pokestop/Gym summary.

The level 14 tooltip only appears when level 17 cells are visible, to avoid visual clutter.

> This project is unofficial and is not affiliated with Niantic, Pokemon GO, or The Pokemon Company. It only adds a visual overlay to the map loaded in your browser.
