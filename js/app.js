async function setup() {
    const patchExportURL = "export/patch.export.json";

    // Create AudioContext
    const WAContext = window.AudioContext || window.webkitAudioContext;
    const context = new WAContext();

    // Create gain node and connect it to audio output
    const outputNode = context.createGain();
    outputNode.connect(context.destination);
    
    // Fetch the exported patcher
    let response, patcher;
    try {
        response = await fetch(patchExportURL);
        patcher = await response.json();
    
        if (!window.RNBO) {
            // Load RNBO script dynamically
            // Note that you can skip this by knowing the RNBO version of your patch
            // beforehand and just include it using a <script> tag
            await loadRNBOScript(patcher.desc.meta.rnboversion);
        }

    } catch (err) {
        const errorContext = {
            error: err
        };
        if (response && (response.status >= 300 || response.status < 200)) {
            errorContext.header = `Couldn't load patcher export bundle`,
            errorContext.description = `Check app.js to see what file it's trying to load. Currently it's` +
            ` trying to load "${patchExportURL}". If that doesn't` + 
            ` match the name of the file you exported from RNBO, modify` + 
            ` patchExportURL in app.js.`;
        }
        if (typeof guardrails === "function") {
            guardrails(errorContext);
        } else {
            throw err;
        }
        return;
    }
    
    // (Optional) Fetch the dependencies
    let dependencies = [];
    try {
        const dependenciesResponse = await fetch("export/dependencies.json");
        dependencies = await dependenciesResponse.json();

        // Prepend "export" to any file dependenciies
        dependencies = dependencies.map(d => d.file ? Object.assign({}, d, { file: "export/" + d.file }) : d);
    } catch (e) {}

    // Create the device
    let device;
    try {
        device = await RNBO.createDevice({ context, patcher });
    } catch (err) {
        if (typeof guardrails === "function") {
            guardrails({ error: err });
        } else {
            throw err;
        }
        return;
    }

    // (Optional) Load the samples
    if (dependencies.length)
        await device.loadDataBufferDependencies(dependencies);

    // Connect the device to the web audio graph
    device.node.connect(outputNode);

    // (Optional) Extract the name and rnbo version of the patcher from the description
    document.getElementById("patcher-title").innerText = (patcher.desc.meta.filename || "Unnamed Patcher") + " (v" + patcher.desc.meta.rnboversion + ")";

    // (Optional) Automatically create sliders for the device parameters
    makeSliders(device);

    // (Optional) Create a form to send messages to RNBO inputs
    // makeInportForm(device);

    // (Optional) Attach listeners to outports so you can log messages from the RNBO patcher
    // attachOutports(device);

    // (Optional) Load presets, if any
    // loadPresets(device, patcher);

    // (Optional) Connect MIDI inputs
    // makeMIDIKeyboard(device);

    document.body.onclick = () => {
        context.resume();
    }

    // Skip if you're not using guardrails.js
    if (typeof guardrails === "function")
        guardrails();
}

function loadRNBOScript(version) {
    return new Promise((resolve, reject) => {
        if (/^\d+\.\d+\.\d+-dev$/.test(version)) {
            throw new Error("Patcher exported with a Debug Version!\nPlease specify the correct RNBO version to use in the code.");
        }
        const el = document.createElement("script");
        el.src = "https://c74-public.nyc3.digitaloceanspaces.com/rnbo/" + encodeURIComponent(version) + "/rnbo.min.js";
        el.onload = resolve;
        el.onerror = function(err) {
            console.log(err);
            reject(new Error("Failed to load rnbo.js v" + version));
        };
        document.body.append(el);
    });
}

function makeSliders(device) {
    const pdiv = document.getElementById("rnbo-parameter-sliders");
    const noParamLabel = document.getElementById("no-param-label");
    if (noParamLabel && device.numParameters > 0) pdiv.removeChild(noParamLabel);

    // -----------------------------
    // Reorder parameters (visual)
    // -----------------------------
    const orderedParams = device.parameters.slice(); // shallow copy

    const targetName = "11: On/Off";
    const groupNames = ["11: Barwa", "11: Poziom szumu", "11: Filtr szumu"];

    const targetIndex = orderedParams.findIndex(p => p.name === targetName);
    const groupIndices = groupNames
      .map(name => orderedParams.findIndex(p => p.name === name))
      .filter(i => i >= 0);

    if (targetIndex >= 0 && groupIndices.length > 0) {
      const insertBeforeIndex = Math.min(...groupIndices);
      const [targetParam] = orderedParams.splice(targetIndex, 1);
      let adjustedIndex = insertBeforeIndex;
      if (targetIndex < insertBeforeIndex) adjustedIndex = insertBeforeIndex - 1;
      orderedParams.splice(adjustedIndex, 0, targetParam);
    }

    // -----------------------------
    // Helpers and state
    // -----------------------------
    let isDraggingSlider = false;
    let uiElements = {};

    function calcPercent(value, min, max) {
        const mn = Number(min), mx = Number(max);
        if (mx === mn) return "0%";
        const pct = ((Number(value) - mn) / (mx - mn)) * 100;
        return Math.max(0, Math.min(100, pct)) + "%";
    }

    // -----------------------------
    // Build UI (iterate orderedParams)
    // -----------------------------
    orderedParams.forEach(param => {
        const row = document.createElement("div");
        row.className = "param-row";

        // Type detection:
        const isBooleanLike = (Number(param.min) === 0 && Number(param.max) === 1 && Number(param.steps) === 2);
        const isRadioLike = (Number(param.steps) > 2);

        const nameSpan = document.createElement("span");
        nameSpan.className = "param-name";
        nameSpan.textContent = param.name || param.id;

        if (isBooleanLike) {
            // Toggle button
            const button = document.createElement("button");
            button.className = "toggle-btn";
            const isOn = Number(param.value) >= 1;
            button.textContent = isOn ? "ON" : "OFF";
            if (isOn) button.classList.add("active");

            button.addEventListener("click", () => {
                const newVal = (Number(param.value) === Number(param.max)) ? Number(param.min) : Number(param.max);
                param.value = newVal;
                const nowOn = Number(newVal) === Number(param.max);
                button.textContent = nowOn ? "ON" : "OFF";
                button.classList.toggle("active", nowOn);
            });

            row.appendChild(button);
            row.appendChild(nameSpan);

            uiElements[param.id] = { button, nameSpan };

        } else if (isRadioLike) {
            // Radio group (horizontal buttons)
            const steps = Number(param.steps);
            const min = Number(param.min);
            const max = Number(param.max);
            const stepValue = (max - min) / (steps - 1);

            const group = document.createElement("div");
            group.className = "radio-group";

            const labels = Array.isArray(param.labels) ? param.labels : null;
            const buttons = [];

            for (let i = 0; i < steps; i++) {
                const value = min + i * stepValue;
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "radio-btn";
                if (labels && labels[i] !== undefined) {
                    btn.textContent = String(labels[i]);
                } else {
                    btn.textContent = Number.isInteger(value) ? String(value) : Number(value).toFixed(2).replace(/\.?0+$/,"");
                }
                btn.dataset.value = String(value);

                btn.addEventListener("click", () => {
                    param.value = value;
                    buttons.forEach(b => b.classList.toggle("active", b === btn));
                });

                group.appendChild(btn);
                buttons.push(btn);
            }

            // Initialize active button based on param.value
            const nearestIndex = Math.round((Number(param.value) - min) / stepValue);
            if (buttons[nearestIndex]) buttons[nearestIndex].classList.add("active");

            row.appendChild(group);
            row.appendChild(nameSpan);

            uiElements[param.id] = { radioGroup: group, radioButtons: buttons, nameSpan, stepValue, min, max };

        } else {
    // Slider without numeric input box
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "param-slider";
    slider.id = param.id;
    slider.name = param.name || param.id;
    slider.min = param.min;
    slider.max = param.max;

    if (param.steps > 1) {
        slider.step = (param.max - param.min) / (param.steps - 1);
    } else {
        slider.step = (param.max - param.min) / 1000.0;
    }
    slider.value = param.value;
    slider.style.setProperty("--percent", calcPercent(param.value, param.min, param.max));

    slider.addEventListener("pointerdown", () => { isDraggingSlider = true; });
    slider.addEventListener("pointerup", () => {
        isDraggingSlider = false;
        slider.value = param.value;
        slider.style.setProperty("--percent", calcPercent(param.value, param.min, param.max));
    });
    slider.addEventListener("input", () => {
        const v = Number.parseFloat(slider.value);
        param.value = v;
        slider.style.setProperty("--percent", calcPercent(v, param.min, param.max));
    });

    row.appendChild(slider);
    row.appendChild(nameSpan);

    uiElements[param.id] = { slider, nameSpan };
}


        row.classList.add(`param-${param.id.replace(/\W/g, "_")}`);
        pdiv.appendChild(row);
    });

    // -----------------------------
    // React to external device changes
    // -----------------------------
    device.parameterChangeEvent.subscribe(ev => {
        const entry = uiElements[ev.id];
        if (!entry) return;

        if (entry.button) {
            const on = Number(ev.value) >= 1;
            entry.button.textContent = on ? "ON" : "OFF";
            entry.button.classList.toggle("active", on);
        }

        if (entry.radioButtons) {
            const min = entry.min;
            const stepVal = entry.stepValue;
            const idx = Math.round((Number(ev.value) - min) / stepVal);
            entry.radioButtons.forEach((b, i) => b.classList.toggle("active", i === idx));
        }

        if (entry.slider && !isDraggingSlider) {
            entry.slider.value = ev.value;
            entry.slider.style.setProperty("--percent", calcPercent(ev.value, device.parameters.find(p => p.id === ev.id).min, device.parameters.find(p => p.id === ev.id).max));
        }
        // if (entry.text) {
        //     entry.text.value = Number(ev.value).toFixed(2);
        // }
    });
}


function makeInportForm(device) {
    const idiv = document.getElementById("rnbo-inports");
    const inportSelect = document.getElementById("inport-select");
    const inportText = document.getElementById("inport-text");
    const inportForm = document.getElementById("inport-form");
    let inportTag = null;
    
    // Device messages correspond to inlets/outlets or inports/outports
    // You can filter for one or the other using the "type" of the message
    const messages = device.messages;
    const inports = messages.filter(message => message.type === RNBO.MessagePortType.Inport);

    if (inports.length === 0) {
        idiv.removeChild(document.getElementById("inport-form"));
        return;
    } else {
        idiv.removeChild(document.getElementById("no-inports-label"));
        inports.forEach(inport => {
            const option = document.createElement("option");
            option.innerText = inport.tag;
            inportSelect.appendChild(option);
        });
        inportSelect.onchange = () => inportTag = inportSelect.value;
        inportTag = inportSelect.value;

        inportForm.onsubmit = (ev) => {
            // Do this or else the page will reload
            ev.preventDefault();

            // Turn the text into a list of numbers (RNBO messages must be numbers, not text)
            const values = inportText.value.split(/\s+/).map(s => parseFloat(s));
            
            // Send the message event to the RNBO device
            let messageEvent = new RNBO.MessageEvent(RNBO.TimeNow, inportTag, values);
            device.scheduleEvent(messageEvent);
        }
    }
}

function attachOutports(device) {
    const outports = device.outports;
    if (outports.length < 1) {
        document.getElementById("rnbo-console").removeChild(document.getElementById("rnbo-console-div"));
        return;
    }

    document.getElementById("rnbo-console").removeChild(document.getElementById("no-outports-label"));
    device.messageEvent.subscribe((ev) => {

        // Ignore message events that don't belong to an outport
        if (outports.findIndex(elt => elt.tag === ev.tag) < 0) return;

        // Message events have a tag as well as a payload
        console.log(`${ev.tag}: ${ev.payload}`);

        document.getElementById("rnbo-console-readout").innerText = `${ev.tag}: ${ev.payload}`;
    });
}

function loadPresets(device, patcher) {
    let presets = patcher.presets || [];
    if (presets.length < 1) {
        document.getElementById("rnbo-presets").removeChild(document.getElementById("preset-select"));
        return;
    }

    document.getElementById("rnbo-presets").removeChild(document.getElementById("no-presets-label"));
    let presetSelect = document.getElementById("preset-select");
    presets.forEach((preset, index) => {
        const option = document.createElement("option");
        option.innerText = preset.name;
        option.value = index;
        presetSelect.appendChild(option);
    });
    presetSelect.onchange = () => device.setPreset(presets[presetSelect.value].preset);
}

function makeMIDIKeyboard(device) {
    let mdiv = document.getElementById("rnbo-clickable-keyboard");
    if (device.numMIDIInputPorts === 0) return;

    mdiv.removeChild(document.getElementById("no-midi-label"));

    const midiNotes = [49, 52, 56, 63];
    midiNotes.forEach(note => {
        const key = document.createElement("div");
        const label = document.createElement("p");
        label.textContent = note;
        key.appendChild(label);
        key.addEventListener("pointerdown", () => {
            let midiChannel = 0;

            // Format a MIDI message paylaod, this constructs a MIDI on event
            let noteOnMessage = [
                144 + midiChannel, // Code for a note on: 10010000 & midi channel (0-15)
                note, // MIDI Note
                100 // MIDI Velocity
            ];
        
            let noteOffMessage = [
                128 + midiChannel, // Code for a note off: 10000000 & midi channel (0-15)
                note, // MIDI Note
                0 // MIDI Velocity
            ];
        
            // Including rnbo.min.js (or the unminified rnbo.js) will add the RNBO object
            // to the global namespace. This includes the TimeNow constant as well as
            // the MIDIEvent constructor.
            let midiPort = 0;
            let noteDurationMs = 250;
        
            // When scheduling an event to occur in the future, use the current audio context time
            // multiplied by 1000 (converting seconds to milliseconds) for now.
            let noteOnEvent = new RNBO.MIDIEvent(device.context.currentTime * 1000, midiPort, noteOnMessage);
            let noteOffEvent = new RNBO.MIDIEvent(device.context.currentTime * 1000 + noteDurationMs, midiPort, noteOffMessage);
        
            device.scheduleEvent(noteOnEvent);
            device.scheduleEvent(noteOffEvent);

            key.classList.add("clicked");
        });

        key.addEventListener("pointerup", () => key.classList.remove("clicked"));

        mdiv.appendChild(key);
    });
}

setup();
