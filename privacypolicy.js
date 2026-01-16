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