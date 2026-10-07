(function () {
  var count = 0;
  var out = document.getElementById("count");
  document.getElementById("btn").addEventListener("click", function () {
    count += 1;
    out.textContent = String(count);
  });
})();
