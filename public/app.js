(() => {
  "use strict";

  const DATA_URL = "data/shorts.json";
  const RENDER_WINDOW = 1; // load current slide +/- this many neighbors as real iframes

  const feedEl = document.getElementById("feed");
  const loadingEl = document.getElementById("loading-screen");
  const emptyEl = document.getElementById("empty-state");
  const retryBtn = document.getElementById("retry-btn");
  const updateBadge = document.getElementById("update-badge");
  const swipeHint = document.getElementById("swipe-hint");

  let shorts = [];
  let activeIndex = 0;
  let muted = true;
  let slideEls = [];
  let observer = null;

  init();

  function init() {
    retryBtn.addEventListener("click", load);
    load();
  }

  async function load() {
    emptyEl.hidden = true;
    loadingEl.hidden = false;
    feedEl.hidden = true;

    try {
      // cache-bust by day so the visitor always gets today's list
      const todayKey = new Date().toISOString().slice(0, 10);
      const res = await fetch(`${DATA_URL}?v=${todayKey}`, { cache: "no-store" });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();

      shorts = Array.isArray(data.shorts) ? data.shorts : [];
      if (shorts.length === 0) throw new Error("empty list");

      renderBadge(data.lastUpdated, shorts.length);
      buildSlides();
      loadingEl.hidden = true;
      feedEl.hidden = false;

      // one-time swipe hint
      if (!sessionStorage.getItem("ff_hint_shown")) {
        swipeHint.hidden = false;
        setTimeout(() => { swipeHint.hidden = true; }, 3500);
        sessionStorage.setItem("ff_hint_shown", "1");
      }
    } catch (err) {
      console.error("FoundersFeed load failed:", err);
      loadingEl.hidden = true;
      emptyEl.hidden = false;
    }
  }

  function renderBadge(lastUpdated, count) {
    if (!lastUpdated) { updateBadge.textContent = `${count} shorts`; return; }
    const d = new Date(lastUpdated);
    const label = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    updateBadge.textContent = `${count} shorts · updated ${label}`;
  }

  function buildSlides() {
    feedEl.innerHTML = "";
    slideEls = shorts.map((short, i) => createSlide(short, i));
    slideEls.forEach((el) => feedEl.appendChild(el));

    setupObserver();
    // mount the first couple of slides immediately
    mountNeighbors(0);
  }

  function createSlide(short, index) {
    const slide = document.createElement("section");
    slide.className = "short-slide";
    slide.dataset.index = String(index);
    slide.dataset.videoId = short.id;

    slide.innerHTML = `
      <div class="placeholder">Loading…</div>
      <div class="overlay-top"></div>
      <div class="overlay-bottom"></div>
      <div class="idx-badge">${index + 1} / ${shorts.length}</div>
      <div class="info">
        ${short.category ? `<span class="category-chip">${escapeHtml(short.category)}</span>` : ""}
        <p class="title">${escapeHtml(short.title || "")}</p>
      </div>
      <div class="rail">
        <button class="mute-btn" title="Toggle sound">🔇</button>
        <button class="open-btn" title="Open on YouTube">↗</button>
        <button class="next-btn" title="Next">⬇</button>
      </div>
    `;

    slide.querySelector(".mute-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMute();
    });
    slide.querySelector(".open-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(`https://www.youtube.com/shorts/${short.id}`, "_blank", "noopener");
    });
    slide.querySelector(".next-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      goTo(index + 1);
    });

    return slide;
  }

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const idx = Number(entry.target.dataset.index);
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            setActive(idx);
          }
        });
      },
      { root: feedEl, threshold: [0, 0.6, 1] }
    );
    slideEls.forEach((el) => observer.observe(el));
  }

  function setActive(idx) {
    if (idx === activeIndex && document.querySelector(".player-frame")) {
      // still ensure mounted
    }
    activeIndex = idx;
    mountNeighbors(idx);
    updateMuteIcons();
  }

  function mountNeighbors(centerIdx) {
    const lo = Math.max(0, centerIdx - RENDER_WINDOW);
    const hi = Math.min(shorts.length - 1, centerIdx + RENDER_WINDOW);

    slideEls.forEach((slide, i) => {
      const within = i >= lo && i <= hi;
      const hasFrame = !!slide.querySelector(".player-frame");
      if (within && !hasFrame) {
        mountIframe(slide, shorts[i].id, i === centerIdx);
      } else if (!within && hasFrame) {
        unmountIframe(slide);
      } else if (within && hasFrame && i === centerIdx) {
        playSlide(slide);
      } else if (within && hasFrame && i !== centerIdx) {
        pauseSlide(slide);
      }
    });
  }

  function mountIframe(slide, videoId, autoplay) {
    const placeholder = slide.querySelector(".placeholder");
    const iframe = document.createElement("iframe");
    iframe.className = "player-frame";
    iframe.src = buildEmbedUrl(videoId, autoplay);
    iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("playsinline", "");
    slide.insertBefore(iframe, placeholder);
    if (placeholder) placeholder.remove();
  }

  function unmountIframe(slide) {
    const iframe = slide.querySelector(".player-frame");
    if (iframe) iframe.remove();
    if (!slide.querySelector(".placeholder")) {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = "…";
      slide.insertBefore(ph, slide.firstChild);
    }
  }

  function buildEmbedUrl(videoId, autoplay) {
    const params = new URLSearchParams({
      autoplay: autoplay ? "1" : "0",
      mute: muted ? "1" : "0",
      loop: "1",
      playlist: videoId,
      controls: "0",
      modestbranding: "1",
      rel: "0",
      playsinline: "1",
      enablejsapi: "1",
    });
    return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
  }

  function playSlide(slide) {
    postToPlayer(slide, muted ? "mute" : "unMute");
    postToPlayer(slide, "playVideo");
  }
  function pauseSlide(slide) {
    postToPlayer(slide, "pauseVideo");
  }

  function postToPlayer(slide, func) {
    const iframe = slide.querySelector(".player-frame");
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage(
        JSON.stringify({ event: "command", func, args: [] }),
        "*"
      );
    } catch (e) { /* no-op */ }
  }

  function toggleMute() {
    muted = !muted;
    updateMuteIcons();
    const activeSlide = slideEls[activeIndex];
    if (activeSlide) {
      postToPlayer(activeSlide, muted ? "mute" : "unMute");
    }
  }

  function updateMuteIcons() {
    slideEls.forEach((slide, i) => {
      const btn = slide.querySelector(".mute-btn");
      if (!btn) return;
      if (i === activeIndex) {
        btn.textContent = muted ? "🔇" : "🔊";
        btn.classList.toggle("active", !muted);
      }
    });
  }

  function goTo(idx) {
    if (idx < 0 || idx >= slideEls.length) return;
    slideEls[idx].scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // keyboard nav for desktop
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); goTo(activeIndex + 1); }
    if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); goTo(activeIndex - 1); }
    if (e.key === "m") toggleMute();
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
