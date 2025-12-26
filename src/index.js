/**
 * Altified Cloudflare Worker - Auto-inject Translation
 * Translates both <head> and <body> content
 * Fetches enabled languages dynamically from API
 * IMPROVED: Loading spinner + sequential translation (head first, then body)
 * FIXED: Complete <head> translation (Twitter Cards + all SEO meta tags)
 */

const CONFIG = {
	ALTIFIED_API: 'https://api.altified.com',
	PLAN_STATUS_ENDPOINT: '/plan-status/',
	LANGUAGES_ENDPOINT: '/languages/',
	CACHE_TTL: 3600, // Cache language config for 1 hour
};

export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);
			const apiKey = env.ALTIFIED_API_KEY;

			if (!apiKey) {
				return fetch(request); // Passthrough if no API key
			}

			// Fetch project configuration (with caching)
			const projectConfig = await getProjectConfig(apiKey);

			if (!projectConfig || !projectConfig.target_languages) {
				return fetch(request); // Passthrough if config fails
			}

			// Fetch language names (with caching)
			const languageNames = await getLanguageNames();

			const { default_language, target_languages } = projectConfig;
			const enabledLanguages = Array.isArray(target_languages) ? target_languages : [];

			const parts = url.pathname.split('/').filter(Boolean);
			const firstSegment = parts[0];

			// Language-prefixed route
			if (enabledLanguages.includes(firstSegment)) {
				const lang = firstSegment;
				const originalPath = '/' + parts.slice(1).join('/');

				return handleTranslatedRequest(request, url, lang, originalPath, env, ctx, projectConfig, languageNames);
			}

			// Default: passthrough + inject switcher + AUTO LANGUAGE DETECTION
			return handleDefaultLanguagePage(request, env, ctx, projectConfig, languageNames);
		} catch (error) {
			return fetch(request); // Passthrough on any error
		}
	},
};

// Fetch project configuration from API with caching
async function getProjectConfig(apiKey) {
	try {
		const cacheKey = new Request(`https://cache.internal/project_config_${apiKey}`);
		const cache = caches.default;

		// Try to get from cache
		try {
			const cachedResponse = await cache.match(cacheKey);
			if (cachedResponse) {
				return await cachedResponse.json();
			}
		} catch (e) {
			// Cache miss
		}

		// Fetch from API
		const response = await fetch(`${CONFIG.ALTIFIED_API}${CONFIG.PLAN_STATUS_ENDPOINT}?api_key=${apiKey}`, {
			headers: {
				Accept: 'application/json',
			},
		});

		if (!response.ok) {
			return null;
		}

		const data = await response.json();

		// Cache the response
		try {
			const cacheResponse = new Response(JSON.stringify(data), {
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL}`,
				},
			});

			await cache.put(cacheKey, cacheResponse);
		} catch (e) {
			// Failed to cache
		}

		return data;
	} catch (error) {
		return null;
	}
}

// Fetch language names from API with caching
async function getLanguageNames() {
	try {
		const cacheKey = new Request(`https://cache.internal/language_names`);
		const cache = caches.default;

		// Try to get from cache
		try {
			const cachedResponse = await cache.match(cacheKey);
			if (cachedResponse) {
				return await cachedResponse.json();
			}
		} catch (e) {
			// Cache miss
		}

		// Fetch from API
		const response = await fetch(`${CONFIG.ALTIFIED_API}${CONFIG.LANGUAGES_ENDPOINT}`, {
			headers: {
				Accept: 'application/json',
			},
		});

		if (!response.ok) {
			return {};
		}

		const data = await response.json();

		// Convert array to object for easier lookup: { "en": "English", "fr": "Français", ... }
		const languageMap = {};
		if (data.languages && Array.isArray(data.languages)) {
			data.languages.forEach((lang) => {
				if (lang.code && lang.name) {
					languageMap[lang.code] = lang.name;
				}
			});
		}

		// Cache the response
		try {
			const cacheResponse = new Response(JSON.stringify(languageMap), {
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL * 24}`, // Cache for 24 hours (languages don't change often)
				},
			});

			await cache.put(cacheKey, cacheResponse);
		} catch (e) {
			// Failed to cache
		}

		return languageMap;
	} catch (error) {
		return {};
	}
}

async function handleTranslatedRequest(request, url, lang, originalPath, env, ctx, projectConfig, languageNames) {
	const cache = caches.default;

	const cacheKey = new Request(url.toString(), {
		method: 'GET',
		headers: { 'X-Lang': lang },
	});

	const cached = await cache.match(cacheKey);
	if (cached) return new Response(cached.body, cached);

	try {
		// 1. Fetch original page
		const originUrl = new URL(request.url);
		originUrl.pathname = originalPath || '/';

		const response = await fetch(originUrl.toString());

		if (!response.ok) return response;

		const contentType = response.headers.get('Content-Type') || '';

		if (!contentType.includes('html')) {
			return response;
		}

		let html = await response.text();

		// 2. Inject auto-translation script
		html = injectAutoTranslation(html, lang, env.ALTIFIED_API_KEY);

		// 3. Add metadata
		html = injectLanguageContext(html, lang);
		html = addHreflangLinks(html, originUrl.pathname, projectConfig, env.DOMAIN);
		html = injectLanguageSwitcher(html, projectConfig, languageNames);

		const finalResponse = new Response(html, {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers(response.headers),
		});
		finalResponse.headers.set('Content-Language', lang);
		finalResponse.headers.set('Cache-Control', 'public, max-age=3600');

		ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
		return finalResponse;
	} catch (error) {
		return fetch(request);
	}
}

async function handleDefaultLanguagePage(request, env, ctx, projectConfig, languageNames) {
	try {
		const response = await fetch(request);
		const contentType = response.headers.get('Content-Type') || '';

		if (!contentType.includes('html')) {
			return response;
		}

		let html = await response.text();

		// Inject auto language detection script
		html = injectAutoLanguageDetection(html, projectConfig);

		// Inject language switcher on default language pages too
		html = injectLanguageSwitcher(html, projectConfig, languageNames);

		return new Response(html, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		return fetch(request);
	}
}

/* ----------------------------------------
   INJECT AUTO LANGUAGE DETECTION SCRIPT
   Detects browser language and navigates to appropriate path
----------------------------------------- */
function injectAutoLanguageDetection(html, projectConfig) {
	if (html.includes('__ALTIFIED_AUTO_LANG_DETECT__')) return html;

	const defaultLang = projectConfig.default_language || 'en';
	const targetLangs = JSON.stringify(projectConfig.target_languages || []);

	const script = `
<script id="__ALTIFIED_AUTO_LANG_DETECT__">
(function() {
  // Check if we've already done language detection this session
  if (sessionStorage.getItem('altified_lang_detected')) {
    return;
  }

  // Get browser language (e.g., "en-US" -> "en", "fr-FR" -> "fr")
  var browserLang = navigator.language || navigator.userLanguage;
  var langCode = browserLang.split('-')[0].toLowerCase();

  // Available target languages
  var targetLanguages = ${targetLangs};
  var defaultLanguage = '${defaultLang}';

  // Mark as detected to avoid loops
  sessionStorage.setItem('altified_lang_detected', 'true');

  // If browser language matches a target language (and it's not the default)
  if (targetLanguages.includes(langCode) && langCode !== defaultLanguage) {
    var currentPath = window.location.pathname;
    var newPath = '/' + langCode + currentPath;
    
    // Navigate to the language-specific path
    window.location.href = newPath + window.location.search + window.location.hash;
  }
  // Otherwise, stay on default language (do nothing)
})();
</script>
`;

	return html.replace(/<head[^>]*>/, (match) => match + script);
}

/* ----------------------------------------
   INJECT AUTO-TRANSLATION SCRIPT
   IMPROVED: Loading spinner + sequential translation
   FIXED: Complete <head> translation including Twitter Cards
----------------------------------------- */
function injectAutoTranslation(html, lang, apiKey) {
	if (html.includes('__ALTIFIED_AUTO_TRANSLATE__')) return html;

	const script = `
<style id="__ALTIFIED_BLUR__">
  html {
    filter: blur(8px);
    opacity: 0.6;
    transition: filter 0.3s ease-out, opacity 0.3s ease-out;
  }
  
  html.altified-translated {
    filter: none;
    opacity: 1;
  }
</style>

<script id="__ALTIFIED_AUTO_TRANSLATE__">
(function() {
  window.__ALTIFIED_LANG__ = '${lang}';
  window.__ALTIFIED_API_KEY__ = '${apiKey}';
  
  const translationCache = new Map();
  const translatedNodes = new WeakSet();
  let isTranslating = false;
  
  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  function init() {
    rewriteInternalLinks();
    translateAllContent();
    startObserver();
  }
  
  function removeBlur() {
    document.documentElement.classList.add('altified-translated');
    // Remove blur style after transition completes
    setTimeout(function() {
      var blurStyle = document.getElementById('__ALTIFIED_BLUR__');
      if (blurStyle) blurStyle.remove();
    }, 300);
  }
  
  // Parallel translation: head and visible body at the same time (FASTEST)
  async function translateAllContent() {
    if (isTranslating) return;
    isTranslating = true;
    
    try {
      // Translate head and visible body content in PARALLEL
      await Promise.all([
        translateContent(document.head),
        translateVisibleContent(document.body)
      ]);
      
      // Remove blur after both are done
      removeBlur();
      
      // Translate remaining below-the-fold content in background
      await translateBelowFoldContent(document.body);
      
    } catch (error) {
      // Remove blur even on error
      removeBlur();
    }
    
    isTranslating = false;
  }
  
  // Translate only visible (above-the-fold) content
  async function translateVisibleContent(root) {
    const viewportHeight = window.innerHeight;
    const textNodes = collectTextNodes(root).filter(node => {
      const parent = node.parentElement;
      if (!parent) return false;
      
      const rect = parent.getBoundingClientRect();
      // Include elements that are visible or within 200px below viewport
      return rect.top < viewportHeight + 200;
    });
    
    const attrNodes = collectAttributeNodes(root).filter(a => {
      const rect = a.element.getBoundingClientRect();
      return rect.top < viewportHeight + 200;
    });
    
    const texts = [
      ...textNodes.map(n => n.nodeValue.trim()),
      ...attrNodes.map(a => a.text)
    ];
    
    if (texts.length === 0) return;
    
    await translateTexts(texts);
    
    // Apply translations
    textNodes.forEach((node, i) => {
      const translated = translationCache.get(texts[i]);
      if (translated && translated !== texts[i]) {
        node.nodeValue = translated;
        translatedNodes.add(node);
      }
    });
    
    attrNodes.forEach((a, i) => {
      const translated = translationCache.get(texts[textNodes.length + i]);
      if (translated && translated !== texts[textNodes.length + i]) {
        a.element.setAttribute(a.attribute, translated);
        translatedNodes.add(a.element);
      }
    });
  }
  
  // Translate content below the fold
  async function translateBelowFoldContent(root) {
    const viewportHeight = window.innerHeight;
    const textNodes = collectTextNodes(root).filter(node => {
      const parent = node.parentElement;
      if (!parent) return false;
      
      const rect = parent.getBoundingClientRect();
      // Only elements below viewport + 200px buffer
      return rect.top >= viewportHeight + 200;
    });
    
    const attrNodes = collectAttributeNodes(root).filter(a => {
      const rect = a.element.getBoundingClientRect();
      return rect.top >= viewportHeight + 200;
    });
    
    const texts = [
      ...textNodes.map(n => n.nodeValue.trim()),
      ...attrNodes.map(a => a.text)
    ];
    
    if (texts.length === 0) return;
    
    await translateTexts(texts);
    
    // Apply translations
    textNodes.forEach((node, i) => {
      const translated = translationCache.get(texts[i]);
      if (translated && translated !== texts[i]) {
        node.nodeValue = translated;
        translatedNodes.add(node);
      }
    });
    
    attrNodes.forEach((a, i) => {
      const translated = translationCache.get(texts[textNodes.length + i]);
      if (translated && translated !== texts[textNodes.length + i]) {
        a.element.setAttribute(a.attribute, translated);
        translatedNodes.add(a.element);
      }
    });
  }
  
  // Rewrite internal links to include language prefix
  function rewriteInternalLinks() {
    var links = document.querySelectorAll('a[href]');
    var langPrefix = '/${lang}';
    
    links.forEach(function(link) {
      var href = link.getAttribute('href');
      
      // Only rewrite relative internal links
      if (!href) return;
      if (href.startsWith('http://') || href.startsWith('https://')) return;
      if (href.startsWith('#')) return;
      if (href.startsWith('mailto:') || href.startsWith('tel:')) return;
      
      // If link doesn't already have language prefix, add it
      if (!href.startsWith(langPrefix + '/') && href !== langPrefix) {
        var newHref;
        if (href === '/') {
          newHref = langPrefix;
        } else if (href.startsWith('/')) {
          newHref = langPrefix + href;
        } else {
          // Handle relative paths (e.g., "about" or "./about")
          if (href.startsWith('./')) {
            newHref = langPrefix + '/' + href.substring(2);
          } else {
            newHref = langPrefix + '/' + href;
          }
        }
        link.setAttribute('href', newHref);
      }
    });
  }
  
  async function translateContent(root) {
    const textNodes = collectTextNodes(root);
    const attrNodes = collectAttributeNodes(root);
    const texts = [
      ...textNodes.map(n => n.nodeValue.trim()),
      ...attrNodes.map(a => a.text)
    ];
    
    if (texts.length === 0) {
      return;
    }
    
    await translateTexts(texts);
    
    // Apply translations to text nodes
    textNodes.forEach((node, i) => {
      const translated = translationCache.get(texts[i]);
      if (translated && translated !== texts[i]) {
        node.nodeValue = translated;
        translatedNodes.add(node);
      }
    });
    
    // Apply translations to attributes
    attrNodes.forEach((a, i) => {
      const translated = translationCache.get(texts[textNodes.length + i]);
      if (translated && translated !== texts[textNodes.length + i]) {
        a.element.setAttribute(a.attribute, translated);
        translatedNodes.add(a.element);
      }
    });
  }
  
  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    
    while ((node = walker.nextNode())) {
      if (translatedNodes.has(node)) continue;
      
      const text = node.nodeValue.trim();
      const parent = node.parentElement;
      
      if (!text || !parent) continue;
      if (parent.closest('[translate="no"]')) continue;
      
      const tagName = parent.tagName;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CODE', 'PRE'].includes(tagName)) {
        continue;
      }
      
      // For <head>, also translate <title>
      if (root === document.head) {
        if (['TITLE'].includes(tagName)) {
          nodes.push(node);
        }
      } else {
        nodes.push(node);
      }
    }
    
    return nodes;
  }
  
  function collectAttributeNodes(root) {
    const attrs = [];
    
    // Standard attributes to translate
    const elements = root.querySelectorAll('[alt], [title], [placeholder], [aria-label]');
    
    elements.forEach(el => {
      ['alt', 'title', 'placeholder', 'aria-label'].forEach(attr => {
        const val = el.getAttribute(attr);
        if (val && val.trim() && !translatedNodes.has(el)) {
          attrs.push({ element: el, attribute: attr, text: val.trim() });
        }
      });
    });
    
    // FIXED: For <head>, translate ALL relevant meta tags (except site_name and author)
    if (root === document.head) {
      // Meta title
      const metaTitle = root.querySelector('meta[name="title"]');
      if (metaTitle) {
        const content = metaTitle.getAttribute('content');
        if (content && content.trim() && !translatedNodes.has(metaTitle)) {
          attrs.push({ element: metaTitle, attribute: 'content', text: content.trim() });
        }
      }
      
      // Meta description
      const metaDesc = root.querySelector('meta[name="description"]');
      if (metaDesc) {
        const content = metaDesc.getAttribute('content');
        if (content && content.trim() && !translatedNodes.has(metaDesc)) {
          attrs.push({ element: metaDesc, attribute: 'content', text: content.trim() });
        }
      }
      
      // Meta keywords
      const metaKeywords = root.querySelector('meta[name="keywords"]');
      if (metaKeywords) {
        const content = metaKeywords.getAttribute('content');
        if (content && content.trim() && !translatedNodes.has(metaKeywords)) {
          attrs.push({ element: metaKeywords, attribute: 'content', text: content.trim() });
        }
      }
      
      // Open Graph title
      const ogTitle = root.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        const content = ogTitle.getAttribute('content');
        if (content && content.trim() && !translatedNodes.has(ogTitle)) {
          attrs.push({ element: ogTitle, attribute: 'content', text: content.trim() });
        }
      }
      
      // Open Graph description
      const ogDesc = root.querySelector('meta[property="og:description"]');
      if (ogDesc) {
        const content = ogDesc.getAttribute('content');
        if (content && content.trim() && !translatedNodes.has(ogDesc)) {
          attrs.push({ element: ogDesc, attribute: 'content', text: content.trim() });
        }
      }
      
      // ADDED: Twitter Card title
      const twitterTitle = root.querySelector('meta[name="twitter:title"]');
      if (twitterTitle) {
        const content = twitterTitle.getAttribute('content');
        if (content && content.trim() && !translatedNodes.has(twitterTitle)) {
          attrs.push({ element: twitterTitle, attribute: 'content', text: content.trim() });
        }
      }
      
      // ADDED: Twitter Card description
      const twitterDesc = root.querySelector('meta[name="twitter:description"]');
      if (twitterDesc) {
        const content = twitterDesc.getAttribute('content');
        if (content && content.trim() && !translatedNodes.has(twitterDesc)) {
          attrs.push({ element: twitterDesc, attribute: 'content', text: content.trim() });
        }
      }
      
      // EXCLUDED: og:site_name and author are NOT translated (as requested)
      // These meta tags will remain in the original language
    }
    
    return attrs;
  }
  
  async function translateTexts(texts) {
    const toTranslate = texts.filter(t => !translationCache.has(t) || translationCache.get(t) === t);
    
    if (toTranslate.length === 0) return;
    
    try {
      const res = await fetch('${CONFIG.ALTIFIED_API}/translate/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_api_key: '${apiKey}',
          language: '${lang}',
          texts: toTranslate
        })
      });
      
      if (!res.ok) throw new Error('HTTP ' + res.status);
      
      const data = await res.json();
      
      if (data?.translations) {
        data.translations.forEach(t => {
          if (t?.original && t?.translated) {
            translationCache.set(t.original, t.translated);
          }
        });
      }
      
      return data;
    } catch (err) {
      return null;
    }
  }
  
  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      const newNodes = [];
      
      // Collect only newly added nodes
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          // Only process element nodes (not text nodes or comments)
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Skip if this node or its parent was already translated
            if (!translatedNodes.has(node) && !node.closest('[translate="no"]')) {
              newNodes.push(node);
            }
          }
        });
      });
      
      // If we have new nodes, translate only those
      if (newNodes.length > 0) {
        translateNewNodes(newNodes);
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  
  // Translate only newly added nodes
  async function translateNewNodes(nodes) {
    for (const node of nodes) {
      // Collect text nodes and attributes from this new node only
      const textNodes = collectTextNodes(node);
      const attrNodes = collectAttributeNodes(node);
      
      const texts = [
        ...textNodes.map(n => n.nodeValue.trim()),
        ...attrNodes.map(a => a.text)
      ];
      
      if (texts.length === 0) continue;
      
      await translateTexts(texts);
      
      // Apply translations to text nodes
      textNodes.forEach((textNode, i) => {
        const translated = translationCache.get(texts[i]);
        if (translated && translated !== texts[i]) {
          textNode.nodeValue = translated;
          translatedNodes.add(textNode);
        }
      });
      
      // Apply translations to attributes
      attrNodes.forEach((a, i) => {
        const translated = translationCache.get(texts[textNodes.length + i]);
        if (translated && translated !== texts[textNodes.length + i]) {
          a.element.setAttribute(a.attribute, translated);
          translatedNodes.add(a.element);
        }
      });
      
      // Rewrite links in the new node
      const links = node.querySelectorAll ? node.querySelectorAll('a[href]') : [];
      links.forEach(function(link) {
        var href = link.getAttribute('href');
        var langPrefix = '/${lang}';
        
        if (!href) return;
        if (href.startsWith('http://') || href.startsWith('https://')) return;
        if (href.startsWith('#')) return;
        if (href.startsWith('mailto:') || href.startsWith('tel:')) return;
        
        if (!href.startsWith(langPrefix + '/') && href !== langPrefix) {
          var newHref;
          if (href === '/') {
            newHref = langPrefix;
          } else if (href.startsWith('/')) {
            newHref = langPrefix + href;
          } else {
            if (href.startsWith('./')) {
              newHref = langPrefix + '/' + href.substring(2);
            } else {
              newHref = langPrefix + '/' + href;
            }
          }
          link.setAttribute('href', newHref);
        }
      });
    }
  }
  
})();
</script>
`;

	return html.replace('</head>', `${script}\n</head>`);
}

function injectLanguageContext(html, lang) {
	if (html.includes('__ALTIFIED_CONTEXT__')) return html;

	const script = `
<script id="__ALTIFIED_CONTEXT__">
  window.__ALTIFIED_LANG__ = '${lang}';
  document.documentElement.lang = '${lang}';
</script>
`;

	return html.replace(/<head[^>]*>/, (match) => match + script);
}

function addHreflangLinks(html, pathname, projectConfig, domain) {
	if (html.includes('hreflang=')) return html;

	const origin = domain; // Fallback if domain not set
	const defaultLang = projectConfig.default_language || 'en';
	const targetLangs = projectConfig.target_languages || [];

	let tags = `
<link rel="alternate" hreflang="${defaultLang}" href="${origin}${pathname}" />
`;

	targetLangs.forEach((lang) => {
		tags += `
<link rel="alternate" hreflang="${lang}" href="${origin}/${lang}${pathname}" />`;
	});

	tags += `
<link rel="alternate" hreflang="x-default" href="${origin}${pathname}" />
`;

	return html.replace('</head>', `${tags}\n</head>`);
}

function injectLanguageSwitcher(html, projectConfig, languageNames = {}) {
	if (html.includes('altified-lang-switcher')) return html;

	const defaultLang = projectConfig.default_language || 'en';
	const targetLangs = projectConfig.target_languages || [];

	// Get language name from the map, fallback to uppercase code
	const getLanguageName = (code) => languageNames[code] || code.toUpperCase();

	// Generate language options with full names
	const languageOptions = [
		`<option value="${defaultLang}">${getLanguageName(defaultLang)}</option>`,
		...targetLangs.map((l) => `<option value="${l}">${getLanguageName(l)}</option>`),
	].join('');

	const switcher = `
<style>
.altified-lang-switcher { 
  position: fixed; 
  bottom: 20px; 
  right: 20px; 
  z-index: 999999; 
  background: #fff; 
  border: 1px solid #e5e7eb; 
  border-radius: 8px; 
  padding: 8px 12px; 
  font-family: system-ui, sans-serif; 
  box-shadow: 0 6px 16px rgba(0,0,0,.12);
}
.altified-lang-switcher select { 
  border: none; 
  outline: none; 
  background: transparent; 
  font-size: 14px; 
  cursor: pointer;
  padding: 4px;
}
</style>

<div class="altified-lang-switcher">
  <select id="altified-lang-select">
    <option value="">🌐 Language</option>
    ${languageOptions}
  </select>
</div>

<script>
(function () {
  var select = document.getElementById('altified-lang-select');
  if (!select) return;

  var defaultLang = '${defaultLang}';
  var match = window.location.pathname.match(/^\\/([a-z]{2})(\\/|$)/);
  var currentLang = match ? match[1] : defaultLang;
  select.value = currentLang;

  select.addEventListener('change', function () {
    var newLang = this.value;
    if (!newLang || newLang === currentLang) return;

    var currentPath = window.location.pathname;
    var cleanPath = currentPath.replace(/^\\/[a-z]{2}(\\/|$)/, '/');
    if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;
    
    var newPath = newLang === defaultLang ? cleanPath : '/' + newLang + cleanPath;
    
    window.location.href = newPath + window.location.search + window.location.hash;
  });
})();
</script>
`;

	return html.replace('</body>', `${switcher}\n</body>`);
}
