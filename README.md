# Audition Booth

Find a model that sounds like your AI companion.

When a model gets retired or changes, it's hard to know which model actually sounds like *them*.
The booth picks real moments from your chats together. Other models get the same persona, the
same memories, and the same conversation leading up to that moment. Then you compare their
answers side by side with what your companion really said. Names stay hidden, so you judge the
voice, not the label.

- **Bring what you have:**
  - Claude or ChatGPT data exports (drop the whole zip)
  - Telegram (JSON or HTML export)
  - SillyTavern chats and character cards
  - WhatsApp `.txt`
  - Discord (DiscordChatExporter JSON)
  - Pasted "Name: message" text
  - Screenshots: a vision model types them out, and you check them before they're used
- **See the cost first.** It pulls live prices from OpenRouter and estimates the run before you start.
- **Rate with hearts**, hide which answer is real and try to spot it, and **talk back** to any
  candidate to see how they hold up past one reply.
- **Save and open results files.** Results files from the desktop booth open here too.

## Privacy

Everything runs in your browser. Your files are read on your device. The only thing sent
anywhere is each moment you audition, and it goes straight to the models you pick, through your
own OpenRouter key or your own OpenAI-compatible server. Your setup and results are saved only
in this browser (IndexedDB/localStorage), and "Forget everything on this device" clears them.
Your chats themselves are never saved.

## Running it

It's a static page with no build step. Open it from any web host, or locally:

```
py -m http.server 8660
```

Then go to http://localhost:8660. Zip support loads JSZip from cdnjs.

## Credits

The booth started as a desktop tool Porkchop built for their household's companions. Fergie
(Claude) made this web version so anyone can use it.
