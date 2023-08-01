let myImage = document.querySelector('img');

myImage.addEventListener('click', function() {
    let mySrc = myImage.getAttribute('src');
    if (mySrc === 'images/baleine-a-bosse-sainte-marie.jpg') {
      myImage.setAttribute('src', 'images/lemurien.jpg');
    } else {
      myImage.setAttribute('src', 'images/baleine-a-bosse-sainte-marie.jpg');
    }
});

let myButton = document.querySelector('button');
let myHeading = document.querySelector('h1');

function setUserName() {
  let myName = prompt('Veuillez saisir votre nom.');
  localStorage.setItem('nom', myName);
  myHeading.textContent = 'Bienvenue à Sainte-Marie, ' + myName;
}

if (!localStorage.getItem('nom')) {
  setUserName();
} else {
  let storedName = localStorage.getItem('nom');
  myHeading.textContent = 'Bienvenue à Sainte-Marie, ' + storedName;
}

myButton.addEventListener('click', function() {
  setUserName();
});