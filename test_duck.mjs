async function run() {
    try {
        const response = await fetch("https://html.duckduckgo.com/html/?q=test");
        const html = await response.text();
        
        // Simple regex to extract hrefs from <a class="result__a" ... href="...">
        const regex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g;
        const links = [];
        let match;
        while ((match = regex.exec(html)) !== null && links.length < 3) {
            links.push(match[1]);
        }
        
        const results = links.map(href => {
            // decode HTML entities (minimal for common ones)
            let decoded = href.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
            
            // if href starts with //, prefix https:
            if (decoded.startsWith("//")) {
                decoded = "https:" + decoded;
            }
            
            // parse with new URL(..., 'https://html.duckduckgo.com')
            const url = new URL(decoded, "https://html.duckduckgo.com");
            
            let finalUrl = url.href;
            // if search param uddg exists, decode and return it
            if (url.searchParams.has("uddg")) {
                finalUrl = decodeURIComponent(url.searchParams.get("uddg"));
            }
            
            return {
                original: href,
                normalized: finalUrl,
                isAbsolute: finalUrl.startsWith("http://") || finalUrl.startsWith("https://")
            };
        });
        
        console.log(JSON.stringify(results, null, 2));
    } catch (err) {
        console.error(err);
    }
}

run();
