document.getElementById('menu-btn').addEventListener('click', function() {
  const menuContent = document.getElementById('menu-content');
  menuContent.classList.toggle('show');
});

// Close menu when clicking outside
document.addEventListener('click', function(event) {
  const menuDropdown = document.getElementById('menu-dropdown');
  const menuBtn = document.getElementById('menu-btn');
  const menuContent = document.getElementById('menu-content');
  
  if (!menuDropdown.contains(event.target)) {
    menuContent.classList.remove('show');
  }
});