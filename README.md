# Tiny Extension

## What It Does
Think of **Tiny Extension** like a tiny invisible messenger running between your **5etools** tab and your **Owlbear Rodeo** tab. Whenever you click a dice roll on a monster statblock in 5etools, this messenger grabs the result and drops it straight into Owlbear Rodeo's Owl20 dice log—so your players see your rolls automatically without you having to type anything or switch tabs.

---

## How the Pieces Work Together
There are 4 main helpers working behind the scenes:

1. **The Watcher (`content-5etools.js` & `statblock-reader.js`)**  
   Sits quietly on your 5etools tab. When you click an attack, save, skill, or damage roll, it reads the numbers, checks if you rolled a Natural 20 or Advantage/Disadvantage, and grabs the attack's description or damage type.
2. **The Messenger (`background.js`)**  
   Lives in Chrome's background. As soon as the Watcher hands it a roll, the Messenger checks your switchboard settings (like hiding monster names) and carries the roll across to your open Owlbear Rodeo tab.
3. **The Translator (`content-obr.js`)**  
   Waits on your Owlbear Rodeo tab. When the Messenger arrives with a roll, the Translator formats it into a neat card that Owl20 understands and hands it over so it pops up in the chat log.
4. **The Switchboard (`popup.html` & `popup.js`)**  
   The little menu you open by clicking the d20 icon in Chrome's toolbar. It shows whether Owlbear Rodeo is connected and lets you flip switches on or off anytime.

---

## What Each Switch in the Popup Does
- **Bridge Enabled:** Turns the whole messenger ON or OFF (pause it when you want to roll secretly just for yourself).
- **Show Creature Name:** Off = hides the monster's name and shows **"DM"** instead; click the little **`▸` arrow** next to it to reveal **Show Action Name** (Off = hides the weapon or spell name as **"Attack"**, **"Damage"**, **"Saving Throw"**, or **"Check"**).
- **Send Descriptions:** Includes the attack's effect text inside a neat clickable dropdown (and lets you send condition rules with **Send to Owl20**); when Off, descriptions show as `[REDACTED]`.
- **Auto-Roll Damage:** Clicking a To-Hit roll automatically rolls the attack's damage dice in 5etools too (doubling the dice on a Natural 20!) and packs them into one clean card.

---

## How to Install It
1. Open Chrome (or Edge) and type **`chrome://extensions`** into the address bar, then press **Enter**.
2. Turn ON **Developer mode** using the switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left corner.
4. Select this **`owl20-5etools`** folder—and you're ready to roll!
