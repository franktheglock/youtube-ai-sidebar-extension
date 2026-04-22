async function test() {
  try {
    const response = await fetch("https://html.duckduckgo.com/html/?q=test");
    const body = await response.text();
    
    // Simple regex to find hrefs in result__a links
    const regex = /class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/g;
    const links = [];
    let match;
    while ((match = regex.exec(body)) !== null && links.length < 5) {
      links.push(match[1]);
    }
    
    console.log(JSON.stringify(links, null, 2));
  } catch (error) {
    console.error(error);
  }
}
test();
