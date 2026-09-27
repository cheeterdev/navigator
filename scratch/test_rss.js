const feeds = [
    'https://techcrunch.com/feed/',
    'https://www.wired.com/feed/rss/',
    'https://arstechnica.com/feed/',
    'https://www.cbsnews.com/latest/rss/main'
];

async function test() {
    for (const feed of feeds) {
        console.log(`Fetching: ${feed}`);
        try {
            const res = await fetch(feed, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            console.log(`Status: ${res.status} ${res.statusText}`);
            if (res.ok) {
                const text = await res.text();
                console.log(`Length: ${text.length} chars`);
                console.log(`Preview: ${text.substring(0, 200)}...\n`);
            }
        } catch (e) {
            console.error(`Error: ${e.message}\n`);
        }
    }
}

test();
