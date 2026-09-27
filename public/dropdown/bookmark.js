let currentUrl = '';
let currentTitle = '';
let bookmarks = JSON.parse(localStorage.getItem('bookmarks') || '[]');

const addBtn = document.getElementById('add-bookmark-btn');
const deleteBtn = document.getElementById('cancel-bookmark-btn');
const nameInput = document.getElementById('name-bookmark');
const urlDisplay = document.getElementById('url-display');

// Empfange die aktuelle URL vom Main-Prozess
window.electronAPI.onCurrentUrlUpdated(({ url, title }) => {
    currentUrl = url;
    currentTitle = title;
    urlDisplay.textContent = url;
    nameInput.value = title || '';
});

addBtn.addEventListener('click', () => {
    if (!currentUrl) return;
    
    // Prüfe ob URL bereits vorhanden ist
    if (bookmarks.some(b => b.url === currentUrl)) {
        alert('Bookmark exists');
        return;
    }
    
    const bookmarkTitle = nameInput.value || currentTitle || 'Bookmark';
    bookmarks.push({ title: bookmarkTitle, url: currentUrl });
    localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
    
    // Benachrichtige das Main-Window
    window.electronAPI.addBookmark(currentUrl, bookmarkTitle);
});

deleteBtn.addEventListener('click', () => {
    if (!currentUrl) return;
    
    bookmarks = bookmarks.filter(b => b.url !== currentUrl);
    localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
    
    // Benachrichtige das Main-Window
    window.electronAPI.removeBookmark(currentUrl);
});