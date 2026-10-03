<h1 align="center">GEV Weather (God's Eye View - Weather Ops Edition)</h1>

<p><strong>GEV Weather</strong> is a real-time, multi-user spatial reasoning and operations platform built specifically for storm chasers, meteorologists, and weather tracking teams.</p>

<blockquote>
  <p><strong>🙏 Attribution &amp; Upstream:</strong><br>
  This project is a specialized fork of the incredible <a href="https://github.com/bilawalsidhu/gods-eye-view">God's Eye View</a> originally created by <a href="https://github.com/bilawalsidhu">Bilawal Sidhu</a>. While the upstream project serves as a brilliant local, single-user spatial reasoning app with aircraft/military-focused voice commands, this fork re-architects the platform for distributed team weather operations.</p>
</blockquote>

<h3>What's different in this fork?</h3>

<p>We have taken the core UI and map interface of God's Eye View and heavily modified the backend and data ingest pipelines to support live chase environments:</p>

<ul>
  <li>🏢 <strong>Multi-User &amp; Shared State:</strong> Transitioned from a single-user local app to a full standalone Node.js backend backed by <strong>PostgreSQL + PostGIS</strong>. It supports Role-Based Access Control (RBAC), shared operational state (targets, annotations, team positions), and real-time synchronization.</li>
  <li>🌪️ <strong>Event-Driven Weather Data:</strong> Replaced polling with low-latency, event-driven ingest directly from NOAA open data AWS notifications (NEXRAD Level II/III, GOES, HRRR, MRMS).</li>
  <li>🔒 <strong>Enterprise-Grade Security:</strong> The standalone backend owns OAuth secrets, encrypted provider tokens, revocable sessions, CSRF checks and role enforcement. Configure provider credentials through operator-managed environment files or secret storage.</li>
  <li>🎙️ <strong>Hands-Free Chase Controls:</strong> Adapted the OpenAI Realtime analyst engine for in-vehicle use. Replaced military/aircraft commands with weather-specific voice actions (e.g., <em>"Show me warnings near our target"</em>, <em>"Switch radar tilt"</em>).</li>
  <li>📻 <strong>Scanner &amp; NWR Integration:</strong> Modified the radio tuner to stream live Emergency Services scanners and NOAA Weather Radio feeds based on your spatial location.</li>
  <li>⚡ <strong>Field-Ready Reliability:</strong> Added shared caching, rate-limiting, request coalescing, and degraded-mode support to handle spotty cellular connections during live storm chases.</li>
</ul>

<h3>Team authentication</h3>

<p>Discord OAuth and Google OIDC use server-enforced application roles. Google identities require explicit administrator approval. See <a href="docs/AUTHENTICATION.md">authentication setup</a> for callback URLs, guild role mappings and emergency administrator bootstrap.</p>

<p>Provider Settings and the credential-writing setup endpoints are removed. Pinokio manages non-secret launcher controls only. Browser-exposed Google Maps and Cesium ion credentials require provider restrictions and a frontend rebuild when changed; see <a href="SECURITY.md">credential security</a>.</p>

<h3>Globe tools and data sources</h3>

DISPLAY ▸ **Draw** adds marks, areas and routes to the map with pointer controls.

Nineteen layers and map sources. **Seventeen have a keyless path.** Provider provenance and attribution are documented in [DATA_SOURCES.md](DATA_SOURCES.md).

**Sits on the real ground.** Entity heights are aligned to work with Google 3D tiles, so aircraft park on aprons and cameras stand on street corners instead of floating.
