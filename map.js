(function(){
  const state = {
    map:null,
    userMarker:null,
    radiusCircle:null,
    deadzoneCircle:null,
    pubsLayer:L.layerGroup(),
    pubs:[],
    filteredPubs:[],
    selected:[],
    routeControl:null,
    lastCenter:null,
    totalTravel:0,
    pubDeadzoneLayer: L.layerGroup(),
    currentPlanKey: null // <-- Track the loaded plan key
  };
  const el=id=>document.getElementById(id);
  const toast=(msg)=>{const t=el('toast'); t.textContent=msg; t.style.display='block'; setTimeout(()=>t.style.display='none',2200);};

  // Map
  state.map=L.map('map', { zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(state.map);
  state.map.setView([-27.4698,153.0251],13);
  state.pubDeadzoneLayer.addTo(state.map); // <-- add this
  window.dispatchEvent(new Event('resize')); // Trigger resize for map to render properly
  // Ensure Leaflet redraws when the window/layout changes (toolbar show/hide, resize)
  window.addEventListener('resize', ()=>{ if(state.map) try{ state.map.invalidateSize(); }catch(e){} });

  // Helper for retrying Overpass fetches (handles rate-limiting)
  async function fetchWithRetry(url, options, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, options);
        if (res.ok) return res;
        if (res.status === 429 || res.status >= 500) { // rate limit or server error
          await new Promise(r => setTimeout(r, delay * (i + 1)));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise(r => setTimeout(r, delay * (i + 1)));
      }
    }
  }

  // Load saved plans
  function refreshPlansDropdown(){
  const select=el('savedPlansSelect');
  const keys=Object.keys(localStorage).filter(k=>k.startsWith('rideon:')).sort();
  select.innerHTML=keys.length?'':'<option value="">(no saved plans)</option>';
  keys.forEach(k=>{const opt=document.createElement('option'); opt.value=k; opt.textContent=k.replace('rideon:',''); select.appendChild(opt);});
  }
  refreshPlansDropdown();

  // User location
  function setUserLocation(lat,lon){
  const ll=(typeof lat==='object')?lat:{lat, lng:lon};
  if(state.userMarker) state.map.removeLayer(state.userMarker);
  state.userMarker=L.marker([ll.lat,ll.lng],{draggable:true}).addTo(state.map).bindTooltip('You are here (drag to adjust)',{permanent:true,direction:'top',offset:[0,-18]}).on('dragend',()=>{state.lastCenter=state.userMarker.getLatLng(); drawRadius();});
  state.lastCenter=state.userMarker.getLatLng(); drawRadius();
  }

  // --- MODIFIED drawRadius to include dead-zone ---
  function drawRadius(){
    const km=parseFloat(el('radiusInput').value||'2');
    const dz=parseFloat(el('deadzoneInput')?.value||'0');
    if(state.radiusCircle) state.map.removeLayer(state.radiusCircle);
    if(state.deadzoneCircle) state.map.removeLayer(state.deadzoneCircle);
    state.radiusCircle=L.circle(state.lastCenter,{
      radius:km*1000,
      color:'#60a5fa',
      weight:1,
      fillColor:'#60a5fa',
      fillOpacity:0.08
    }).addTo(state.map);
    if(dz>0){
      state.deadzoneCircle=L.circle(state.lastCenter,{
        radius:dz*1000,
        color:'#ef4444',
        weight:1,
        fillColor:'#ef4444',
        fillOpacity:0.10,
        dashArray:'4 4'
      }).addTo(state.map);
    }
  }

  // --- Add event listener for deadzone input ---
  el('radiusInput').addEventListener('input',drawRadius);
  if(document.getElementById('deadzoneInput')){
    el('deadzoneInput').addEventListener('input',drawRadius);
  }

  // Geolocate
  el('locateBtn').addEventListener('click',()=>{
  if(!navigator.geolocation){toast('Geolocation unsupported. Use the search box.');return;}
  navigator.geolocation.getCurrentPosition(pos=>{const{latitude,longitude}=pos.coords; state.map.setView([latitude,longitude],15); setUserLocation(latitude,longitude); toast('Location set.');},err=>{toast('Location failed: '+err.message);});
  });

  // Manual search
  el('searchBtn').addEventListener('click',()=>{
    const q=el('searchBox').value.trim().toLowerCase();
    if(!q){toast('Enter a pub or road to search.'); return;}
    if(!state.pubs.length){toast('Find pubs first.'); return;}
    state.filteredPubs = state.pubs.filter(p => {
      // Match by pub name
      if (p.name && p.name.toLowerCase().includes(q)) return true;
      // Match by road/street name in tags
      if (p.tags && (
        (p.tags['addr:street'] && p.tags['addr:street'].toLowerCase().includes(q)) ||
        (p.tags['street'] && p.tags['street'].toLowerCase().includes(q)) ||
        (p.tags['addr:road'] && p.tags['addr:road'].toLowerCase().includes(q))
      )) return true;
      return false;
    });
    if(!state.filteredPubs.length){toast('No matching pubs found.'); return;}
    renderPubs(state.filteredPubs);
    const first=state.filteredPubs[0]; state.map.setView([first.lat,first.lon],15);
    toast(`${state.filteredPubs.length} pub(s) matched.`);
  });

  // Find pubs
  el('findBtn').addEventListener('click',async()=>{
  if(!state.lastCenter){toast('Set your location first.'); return;}
  const km=parseFloat(el('radiusInput').value||'2');
  const dz=parseFloat(el('deadzoneInput')?.value||'0');
  const amenities=el('amenitySelect').value;
  const {lat,lng}=state.lastCenter;
  const query=`[out:json][timeout:30];(node["amenity"~"^(${amenities})$"](around:${Math.round(km*1000)},${lat},${lng});way["amenity"~"^(${amenities})$"](around:${Math.round(km*1000)},${lat},${lng});relation["amenity"~"^(${amenities})$"](around:${Math.round(km*1000)},${lat},${lng}););out center tags;`;
  try{
    toast('Searching nearby…');
    const res=await fetchWithRetry('https://overpass-api.de/api/interpreter',{method:'POST',body:query,headers:{'Content-Type':'text/plain'}});
    const data=await res.json();
    state.pubs=data.elements.map(elm=>{
      const c=elm.center||{lat:elm.lat,lon:elm.lon};
      return{id:`${elm.type}/${elm.id}`,name:elm.tags?.name||'(Unnamed)',lat:c.lat,lon:c.lon,tags:elm.tags||{}}
    });
    // --- Filter out pubs within the dead-zone ---
    if(dz>0){
      state.pubs=state.pubs.filter(pub=>{
        const dist=turf.distance([lng,lat],[pub.lon,pub.lat],{units:'kilometers'});
        return dist>=dz;
      });
    }
    // --- Filter out pubs within any selected pub's dead-zone ---
    if(state.selected.length){
      state.pubs = state.pubs.filter(pub => {
        return !state.selected.some(sel => {
          if(sel.deadzone && sel.deadzone > 0){
            const d = turf.distance([sel.lon, sel.lat], [pub.lon, pub.lat], {units:'kilometers'});
            return d < sel.deadzone;
          }
          return false;
        });
      });
    }
    renderPubs(state.pubs);
    toast(`Found ${state.pubs.length} pubs.`);
  }catch(e){console.error(e); toast('Overpass query failed.');}
  });

  // Render pubs
  function renderPubs(elements){
  state.pubsLayer.clearLayers();
  elements.forEach(elm=>{
  const marker=L.marker([elm.lat,elm.lon]).addTo(state.pubsLayer);
  marker.bindPopup(pubPopupHtml(elm));
  marker.on('popupopen',()=>attachPopupHandlers(elm));
  });
  state.pubsLayer.addTo(state.map);
  }

  // Popup HTML
  function pubPopupHtml(pub){
  const gmapsUrl=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pub.name)}`;
  return `<div class="popupContent">
  <div class="title">${escapeHtml(pub.name)}</div>
  <div class="sub">Lat ${pub.lat.toFixed(5)}, Lon ${pub.lon.toFixed(5)}</div>
  <div class="hr"></div>
  <div class="row" style="display:flex; gap:6px; margin-top:8px;">
  <button class="addRideOn" data-id="${pub.id}" data-name="${escapeHtml(pub.name)}" data-lat="${pub.lat}" data-lon="${pub.lon}">Add to Ride‑On</button>
  <a class="link" href="${gmapsUrl}" target="_blank" rel="noopener">Open in Google Maps ↗</a>
  </div>
  <div class="tiny sub" id="tt-${pub.id}"></div>
  </div>`;
  }

  // Attach popup buttons
  function attachPopupHandlers(pub){
  const addBtn=document.querySelector('.addRideOn'); if(addBtn) addBtn.onclick=()=>{ addSelected({id:pub.id,name:pub.name,lat:pub.lat,lon:pub.lon});};
  }

  // Add selected
  function addSelected(pub){
    if(state.selected.find(p=>p.id===pub.id)){toast('Already added.'); return;}
    pub.deadzone = pub.deadzone || 0; // <-- initialize per-pub deadzone
    state.selected.push(pub); renderSelected(); updateRideonSummary();
  }

  // Render selected list
  function renderSelected(){
  const root=el('selectedList'); root.innerHTML='';
  let prev = state.userMarker?.getLatLng() || null;
  state.selected.forEach((p,idx)=>{
    const card=document.createElement('div'); card.className='card';
    let distText = '';
    if (prev) {
      // Calculate distance in km using turf
      const from = [prev.lng, prev.lat];
      const to = [p.lon, p.lat];
      const dist = turf.distance(from, to, {units:'kilometers'});
      distText = `Distance: ${dist.toFixed(2)} km`;
    } else {
      distText = 'Distance: ?';
    }
    card.innerHTML=`<div class="flex space wrap">
    <div class="pubTitle">${escapeHtml(p.name)}</div>
    <div class="pill">Stop ${idx+1}</div>
    </div>
    <div class="flex wrap tiny muted">
    <span>${distText}</span>
    </div>
    <div class="flex" style="gap:6px; flex-wrap:wrap">
    <button data-idx="${idx}" class="up ghost">↑</button>
    <button data-idx="${idx}" class="down ghost">↓</button>
    <button data-idx="${idx}" class="remove danger">Remove</button>
    <input type="number" min="0" step="0.1" value="${p.deadzone||''}" placeholder="Dead-zone (km)" style="width:90px" data-idx="${idx}" class="pub-deadzone-input" />
    <button data-idx="${idx}" class="set-pub-deadzone ghost">Set </button>
    </div>`;
    root.appendChild(card);
    prev = {lat: p.lat, lng: p.lon};
  });
  // buttons
  root.querySelectorAll('.remove').forEach(btn=> btn.onclick=()=>{ const i=parseInt(btn.dataset.idx); state.selected.splice(i,1); renderSelected(); updateRideonSummary(); drawPubDeadzones(); });
  root.querySelectorAll('.up').forEach(btn=> btn.onclick=()=>{ const i=parseInt(btn.dataset.idx); if(i>0){ [state.selected[i-1],state.selected[i]]=[state.selected[i],state.selected[i-1]]; renderSelected(); updateRideonSummary(); drawPubDeadzones(); }});
  root.querySelectorAll('.down').forEach(btn=> btn.onclick=()=>{ const i=parseInt(btn.dataset.idx); if(i<state.selected.length-1){ [state.selected[i+1],state.selected[i]]=[state.selected[i],state.selected[i+1]]; renderSelected(); updateRideonSummary(); drawPubDeadzones(); }});
  root.querySelectorAll('.set-pub-deadzone').forEach(btn => btn.onclick = () => {
    const i = parseInt(btn.dataset.idx);
    const input = root.querySelector(`.pub-deadzone-input[data-idx="${i}"]`);
    const val = parseFloat(input.value) || 0;
    state.selected[i].deadzone = val;
    renderSelected();
    updateRideonSummary();
    drawPubDeadzones();
  });
  drawPubDeadzones();
  }

  // --- Draw per-pub deadzones ---
  function drawPubDeadzones() {
    state.pubDeadzoneLayer.clearLayers();
    state.selected.forEach(p => {
      if (p.deadzone && p.deadzone > 0) {
        L.circle([p.lat, p.lon], {
          radius: p.deadzone * 1000,
          color: '#ef4444',
          weight: 1,
          fillColor: '#ef4444',
          fillOpacity: 0.10,
          dashArray: '4 4'
        }).addTo(state.pubDeadzoneLayer);
      }
    });
  }

  // Ride-On summary
  async function updateRideonSummary(){
    const total = state.selected.length;
    if (total < 1 || !state.userMarker) {
      el('rideonSummary').textContent = `Total trips: ${total} • Estimated travel time: 0 min`;
      return;
    }
    // Build coordinates: start at user, then each pub
    const coords = [state.userMarker.getLatLng(), ...state.selected.map(p => ({lat: p.lat, lng: p.lon}))];
    if (coords.length < 2) {
      el('rideonSummary').textContent = `Total trips: ${total} • Estimated travel time: 0 min`;
      return;
    }
    // Build OSRM coordinates string
    const coordStr = coords.map(c => `${c.lng},${c.lat}`).join(';');
    try {
      const url = `https://router.project-osrm.org/route/v1/foot/${coordStr}?overview=false&steps=false&annotations=duration,distance`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.code !== "Ok" || !data.routes || !data.routes[0]) throw new Error("No route");
      const route = data.routes[0];
      const totalMinutes = Math.round(route.duration / 60);
      const totalKm = (route.distance / 1000).toFixed(2);
      el('rideonSummary').textContent = `Total trips: ${total} • Estimated travel time: ${totalMinutes} min • Distance: ${totalKm} km`;
    } catch (e) {
      el('rideonSummary').textContent = `Total trips: ${total} • Estimated travel time: ?`;
    }
  }

  // Clear pubs
  el('clearPubsBtn').addEventListener('click',()=>{state.pubsLayer.clearLayers(); toast('Cleared map pubs.');});

  // Route
  el('routeBtn').addEventListener('click',()=>{ 
  if(state.routeControl){state.map.removeControl(state.routeControl); state.routeControl=null;}
  const wps=[];
  const start=state.userMarker?.getLatLng();
  if(start) wps.push(L.latLng(start.lat,start.lng));
  state.selected.forEach(p=>wps.push(L.latLng(p.lat,p.lon)));
  if(wps.length<2){toast('Add at least one pub (and set your location)'); return;}
  state.routeControl=L.Routing.control({waypoints:wps,router:L.Routing.osrmv1({serviceUrl:'https://router.project-osrm.org/route/v1'}),lineOptions:{styles:[{color:'#60a5fa',weight:4}]},createMarker:i=>L.marker(wps[i]),addWaypoints:false,draggableWaypoints:false,routeWhileDragging:false}).addTo(state.map);
  });

  // Reset route
  el('resetRouteBtn').addEventListener('click',()=>{if(state.routeControl){state.map.removeControl(state.routeControl); state.routeControl=null;}});

  // Save/load plans
  el('savePlanBtn').textContent = "Save";
  el('savePlanBtn').addEventListener('click', () => {
    let planName = el('planName').value.trim();
    // If editing an existing plan, update it
    if (state.currentPlanKey) {
      localStorage.setItem(state.currentPlanKey, JSON.stringify(state.selected));
      toast('Plan updated.');
      refreshPlansDropdown();
      el('planName').value = ""; // Clear after saving
      state.currentPlanKey = null; // Also clear currentPlanKey for new plans
      return;
    }
    // Otherwise, save as new (or overwrite if exists)
    if (!planName) {
      toast('Enter a plan name');
      return;
    }
    const key = `rideon:${planName}`;
    localStorage.setItem(key, JSON.stringify(state.selected));
    state.currentPlanKey = key;
    toast('Plan saved.');
    refreshPlansDropdown();
    el('planName').value = ""; // Clear after saving
    state.currentPlanKey = null; // Also clear currentPlanKey for new plans
  });

  el('loadPlanBtn').addEventListener('click',()=>{
    const key=el('savedPlansSelect').value;
    if(!key){toast('Choose a plan'); return;}
    try{
      state.selected=JSON.parse(localStorage.getItem(key)||'[]');
      state.currentPlanKey = key; // <-- Track which plan is loaded
      // Set the plan name input for user clarity (optional)
      el('planName').value = key.replace('rideon:','');
      renderSelected();
      updateRideonSummary();
      toast('Plan loaded.');
      // --- Add routing visual when loading a plan ---
      if(state.routeControl){
        state.map.removeControl(state.routeControl);
        state.routeControl=null;
      }
      const wps=[];
      const start=state.userMarker?.getLatLng();
      if(start) wps.push(L.latLng(start.lat,start.lng));
      state.selected.forEach(p=>wps.push(L.latLng(p.lat,p.lon)));
      if(wps.length>=2){
        state.routeControl=L.Routing.control({
          waypoints:wps,
          router:L.Routing.osrmv1({serviceUrl:'https://router.project-osrm.org/route/v1'}),
          lineOptions:{styles:[{color:'#60a5fa',weight:4}]},
          createMarker:i=>L.marker(wps[i]),
          addWaypoints:false,
          draggableWaypoints:false,
          routeWhileDragging:false
        }).addTo(state.map);
      }
    }catch(e){
      toast('Failed to load plan.');
    }
  });

  el('deletePlanBtn').addEventListener('click',()=>{
    const key=el('savedPlansSelect').value;
    if(!key){toast('Choose a plan'); return;}
    localStorage.removeItem(key);
    if(state.currentPlanKey === key) state.currentPlanKey = null; // Clear if deleted
    refreshPlansDropdown();
    renderSelected();
    updateRideonSummary();
    toast('Plan deleted.');
  });

  // Share Ride-On plan
  el('sharePlanBtn').addEventListener('click', () => {
    if (!state.selected.length) {
      toast('Add at least one pub to share.');
      return;
    }
    // Encode selected pubs as base64 JSON
    const data = btoa(encodeURIComponent(JSON.stringify(state.selected)));
    const url = `${location.origin}${location.pathname}?rideon=${data}`;
    navigator.clipboard.writeText(url)
      .then(() => toast('Shareable link copied!'))
      .catch(() => toast('Failed to copy link.'));
  });

  // On page load: check for ?rideon= param and load plan if present
  (function loadSharedRideOn() {
    const params = new URLSearchParams(location.search);
    const rideon = params.get('rideon');
    if (rideon) {
      try {
        const decoded = decodeURIComponent(atob(rideon));
        const pubs = JSON.parse(decoded);
        if (Array.isArray(pubs) && pubs.length) {
          state.selected = pubs;
          renderSelected();
          updateRideonSummary();
          toast('Loaded shared Ride‑On!');
        }
      } catch (e) {
        // ignore
      }
    }
  })();

  // Manual address/street geocoding for user location
  el('manualAddressBtn').addEventListener('click', async () => {
    const address = el('manualAddressInput').value.trim();
    if (!address) { toast('Enter an address or street.'); return; }
    toast('Searching for address...');
    try {
      // Use Nominatim for geocoding
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      if (!data.length) { toast('Address not found.'); return; }
      const { lat, lon, display_name } = data[0];
      setUserLocation(parseFloat(lat), parseFloat(lon));
      state.map.setView([lat, lon], 15);
      toast('Location set: ' + display_name);
    } catch (e) {
      toast('Failed to find address.');
    }
  });

  // Ride-On dropdown toggle logic
  el('rideonDropdownToggle').addEventListener('click', () => {
    const content = el('rideonDropdownContent');
    const arrow = el('rideonDropdownArrow');
    if (content.style.display === 'none') {
      content.style.display = '';
      arrow.style.transform = 'rotate(180deg)';
    } else {
      content.style.display = 'none';
      arrow.style.transform = '';
    }
  });
  // Optionally, open by default on desktop:
  el('rideonDropdownContent').style.display = 'none';

  // Clear currentPlanKey if plan name is changed (for new ride-ons)
  el('planName').addEventListener('input', () => {
    const typed = el('planName').value.trim();
    if (!state.currentPlanKey) return;
    // If the typed name doesn't match the loaded plan, clear currentPlanKey
    if (state.currentPlanKey.replace('rideon:', '') !== typed) {
      state.currentPlanKey = null;
    }
  });

  // --- Generate Random Route Button Logic ---
  el('randomRouteBtn').addEventListener('click', async () => {
    if (!state.lastCenter) {
      toast('Set your location first.');
      return;
    }
    let km = parseFloat(el('radiusInput').value || '0');
    let dz = parseFloat(el('deadzoneInput')?.value || '0');
    if (!km || km <= 0) km = 100;
    if (!dz || dz < 0) dz = 0;
    const amenities = el('amenitySelect').value;
    const { lat, lng } = state.lastCenter;
    const query = `[out:json][timeout:30];(node["amenity"~"^(${amenities})$"](around:${Math.round(km*1000)},${lat},${lng});way["amenity"~"^(${amenities})$"](around:${Math.round(km*1000)},${lat},${lng});relation["amenity"~"^(${amenities})$"](around:${Math.round(km*1000)},${lat},${lng}););out center tags;`;
    try {
      toast('Finding random pubs…');
      const res = await fetchWithRetry('https://overpass-api.de/api/interpreter', { method: 'POST', body: query, headers: { 'Content-Type': 'text/plain' } });
      const data = await res.json();
      let pubs = data.elements.map(elm => {
        const c = elm.center || { lat: elm.lat, lon: elm.lon };
        return { id: `${elm.type}/${elm.id}`, name: elm.tags?.name || '(Unnamed)', lat: c.lat, lon: c.lon, tags: elm.tags || {} }
      });
      // Filter out pubs within the dead-zone
      if (dz > 0) {
        pubs = pubs.filter(pub => {
          const dist = turf.distance([lng, lat], [pub.lon, pub.lat], { units: 'kilometers' });
          return dist >= dz;
        });
      }
      if (pubs.length < 3) {
        toast('Not enough pubs found for a random route.');
        return;
      }
      // Calculate distance from user for each pub
      pubs.forEach(pub => {
        pub._dist = turf.distance([lng, lat], [pub.lon, pub.lat], { units: 'kilometers' });
      });
      // Sort pubs by distance from user (ascending)
      pubs.sort((a, b) => a._dist - b._dist);

      // Find all valid outward, non-backtracking combinations
      let combos = [];
      for (let i = 0; i < pubs.length - 2; i++) {
        for (let j = i + 1; j < pubs.length - 1; j++) {
          for (let k = j + 1; k < pubs.length; k++) {
            const p1 = pubs[i], p2 = pubs[j], p3 = pubs[k];
            // Check angles: user->p1->p2 and p1->p2->p3
            const user = [lng, lat];
            const a = [p1.lon, p1.lat];
            const b = [p2.lon, p2.lat];
            const c = [p3.lon, p3.lat];
            // Helper to get angle between three points (in degrees)
            function angle(p0, p1, p2) {
              const v1 = [p1[0] - p0[0], p1[1] - p0[1]];
              const v2 = [p2[0] - p1[0], p2[1] - p1[1]];
              const dot = v1[0]*v2[0] + v1[1]*v2[1];
              const mag1 = Math.sqrt(v1[0]**2 + v1[1]**2);
              const mag2 = Math.sqrt(v2[0]**2 + v2[1]**2);
              return Math.acos(dot/(mag1*mag2+1e-8)) * 180/Math.PI;
            }
            const angle1 = angle(user, a, b);
            const angle2 = angle(a, b, c);
            // Only allow if both angles are less than 90° (no sharp reversals)
            if (angle1 < 90 && angle2 < 90) {
              combos.push([p1, p2, p3]);
            }
          }
        }
      }
      if (combos.length === 0) {
        toast('Could not find a suitable outward route.');
        return;
      }
      // Pick a random valid route
      const selectedPubs = combos[Math.floor(Math.random() * combos.length)];
      state.selected = selectedPubs;
      renderSelected();
      updateRideonSummary();
      // Draw route line
      if(state.routeControl){state.map.removeControl(state.routeControl); state.routeControl=null;}
      const wps = [];
      const start = state.userMarker?.getLatLng();
      if(start) wps.push(L.latLng(start.lat, start.lng));
      selectedPubs.forEach(p=>wps.push(L.latLng(p.lat, p.lon)));
      if(wps.length>=2){
        state.routeControl=L.Routing.control({
          waypoints:wps,
          router:L.Routing.osrmv1({serviceUrl:'https://router.project-osrm.org/route/v1'}),
          lineOptions:{styles:[{color:'#60a5fa',weight:4}]},
          createMarker:i=>L.marker(wps[i]),
          addWaypoints:false,
          draggableWaypoints:false,
          routeWhileDragging:false
        }).addTo(state.map);
      }
      // Zoom to fit route
      const group = L.featureGroup(wps.map(ll=>L.marker(ll)));
      state.map.fitBounds(group.getBounds().pad(0.3));
      toast(`Random route: ${selectedPubs.length} pubs.`);
    } catch (e) {
      toast('Failed to generate random route.');
    }
  });

function escapeHtml(s){return(s||'').replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));}

// Restore controls if they were moved into a temporary mobile toolbar
(function restoreControls(){
  try{
    const sidebar = document.getElementById('sidebar');
    const controls = document.querySelector('.controls');
    const ref = sidebar.querySelector('.sectionTitle') || null;
    if(controls && sidebar && !sidebar.contains(controls)){
      sidebar.insertBefore(controls, ref);
    }
  }catch(e){/* ignore */}
})();

})();

// Mobile toolbar init
(function initMobileToolbar(){
  try{
    const mq = window.matchMedia('(max-width:600px)');
    const mobileToolbar = document.getElementById('mobileToolbar');
    const mobileInner = mobileToolbar && mobileToolbar.querySelector('.mobile-toolbar-inner');
    const controls = document.querySelector('.controls');
    function createOpenButton(){
      if(document.getElementById('mobileToolbarOpen')) return;
      const openBtn = document.createElement('button');
      openBtn.id = 'mobileToolbarOpen';
      openBtn.className = 'mobile-toolbar-toggle';
      openBtn.textContent = 'Tools';
      // place the open button at the bottom-right of the screen when toolbar is closed
      openBtn.style.bottom = '8px';
      openBtn.style.right = '12px';
      openBtn.style.left = 'auto';
      openBtn.style.transform = 'none';
      openBtn.onclick = ()=>{
        const mt = document.getElementById('mobileToolbar');
        if(mt) mt.style.display='block';
        openBtn.remove();
        const tbtn=document.getElementById('mobileToolbarToggle'); if(tbtn) tbtn.style.display='';
        // after showing, adjust the hide button to sit attached to the toolbar and center it
        setTimeout(()=>{
          const tbtn2 = document.getElementById('mobileToolbarToggle');
          if(tbtn2 && mt){ 
            tbtn2.style.bottom = `${Math.max(8, mt.getBoundingClientRect().height - 8)}px`;
            tbtn2.style.left = '50%'; tbtn2.style.right = 'auto'; tbtn2.style.transform = 'translateX(-50%)';
          }
          // if welcome overlay is visible on launch, hide the hide button behind it
          const welcome = document.getElementById('welcomeOverlay');
          if(welcome && window.getComputedStyle(welcome).display !== 'none'){
            const tb = document.getElementById('mobileToolbarToggle'); if(tb) tb.style.zIndex='99990';
          }
          window.dispatchEvent(new Event('resize'));
        }, 120);
      };
      document.body.appendChild(openBtn);
    }
    function enable(){
      if(!mobileToolbar || !mobileInner || !controls) return;
      if(!mobileToolbar.contains(controls)){
        // save restore info and move main controls
        controls.__restore = { parent: controls.parentNode, nextSibling: controls.nextSibling };
        mobileInner.appendChild(controls);

        // Move selected stops, summary and footer into the toolbar for a compact mobile view
        const extras = [document.querySelector('.sectionTitle'), document.getElementById('selectedList'), document.getElementById('rideonSummary'), document.querySelector('.footer')];
        extras.forEach(el=>{
          if(!el) return;
          if(!mobileInner.contains(el)){
            el.__restore = { parent: el.parentNode, nextSibling: el.nextSibling };
            mobileInner.appendChild(el);
          }
        });

        mobileToolbar.setAttribute('aria-hidden','false');
        let btn = document.getElementById('mobileToolbarToggle');
        if(!btn){
          btn = document.createElement('button'); btn.id='mobileToolbarToggle'; btn.className='mobile-toolbar-toggle'; btn.textContent='Hide';
          btn.onclick = ()=>{ mobileToolbar.style.display='none'; btn.style.display='none'; createOpenButton(); setTimeout(()=>window.dispatchEvent(new Event('resize')), 250); };
          document.body.appendChild(btn);
        } else { btn.style.display=''; }
        // position the hide button slightly overlapping the toolbar so it appears attached
        setTimeout(()=>{
          try{
            const h = mobileToolbar.getBoundingClientRect().height || mobileToolbar.offsetHeight;
            // place it slightly inside the toolbar (overlap by 8px) and center it horizontally
            btn.style.bottom = `${Math.max(8, h - 8)}px`;
            btn.style.left = '50%'; btn.style.right = 'auto'; btn.style.transform = 'translateX(-50%)';
            // if welcome overlay is visible, ensure hide button sits behind it
            const welcome = document.getElementById('welcomeOverlay');
            if(welcome && window.getComputedStyle(welcome).display !== 'none'){
              btn.style.zIndex = '99990';
            } else {
              btn.style.zIndex = '99999';
            }
          }catch(e){}
        },120);
        // ensure map redraws under new layout
        setTimeout(()=>window.dispatchEvent(new Event('resize')), 250);
      }
    }
    function disable(){
      // restore main controls
      if(controls && controls.__restore){ const info = controls.__restore; if(info.parent){ info.parent.insertBefore(controls, info.nextSibling); } }
      // restore extras
      const extras = [document.querySelector('.sectionTitle'), document.getElementById('selectedList'), document.getElementById('rideonSummary'), document.querySelector('.footer')];
      extras.forEach(el=>{
        if(!el || !el.__restore) return;
        const info = el.__restore; if(info.parent){ info.parent.insertBefore(el, info.nextSibling); }
      });
      if(mobileToolbar){ mobileToolbar.setAttribute('aria-hidden','true'); mobileToolbar.style.display=''; }
      const btn = document.getElementById('mobileToolbarToggle'); if(btn) btn.style.display='none';
      const openBtn = document.getElementById('mobileToolbarOpen'); if(openBtn) openBtn.remove();
      setTimeout(()=>window.dispatchEvent(new Event('resize')), 250);
    }
    function handleChange(e){ if(e.matches) enable(); else disable(); }
    if(mq.addEventListener) mq.addEventListener('change', handleChange); else mq.addListener(handleChange);
    if(mq.matches) enable();
    window.addEventListener('resize', ()=>{ if(window.matchMedia('(max-width:600px)').matches) enable(); else disable();
      // also recompute hide button position if visible
      setTimeout(()=>{
        const mt = document.getElementById('mobileToolbar');
        const btn = document.getElementById('mobileToolbarToggle');
        if(mt && btn && mt.getBoundingClientRect().height>0){ try{ btn.style.bottom = `${mt.getBoundingClientRect().height + 12}px`; btn.style.left='50%'; btn.style.right='auto'; btn.style.transform='translateX(-50%)'; }catch(e){} }
      }, 80);
    });
  }catch(e){/* ignore */}

// Operations banner
const banner = document.getElementById('operations-banner');
const dismissBtn = document.getElementById('dismiss-banner');
const operationsBtn = document.getElementById('operations-btn');

// Check if banner was dismissed
if (localStorage.getItem('operationsBannerDismissed')) {
  banner.classList.add('hidden');
}

// Dismiss banner
dismissBtn.addEventListener('click', () => {
  banner.classList.add('hidden');
  localStorage.setItem('operationsBannerDismissed', 'true');
});

// Go to operations page
operationsBtn.addEventListener('click', () => {
  window.location.href = 'operations.html';
});

// Menu dropdown
const menuBtn = document.getElementById('menu-btn');
const menuDropdown = document.getElementById('menu-dropdown');
menuBtn.addEventListener('click', () => {
  menuDropdown.classList.toggle('open');
});
// Close when clicking outside
document.addEventListener('click', (e) => {
  if (!menuDropdown.contains(e.target)) {
    menuDropdown.classList.remove('open');
  }
});

})();